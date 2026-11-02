import { toast } from "sonner";
import { onKvistcodeEvent } from "@/lib/api";
import { tileNeighbour } from "@/lib/helpers";
import { publishScheduleEvent } from "@/lib/scheduleEvents";
import { TURN_ONLY_PREFIX } from "@/lib/background";
import { isResumedBody } from "@/lib/limitResume";
import { routeTerminalExit, routeTerminalOutput } from "@/lib/terminal-bus";
import { switchAccount, switchCandidates } from "@/lib/actions";
import type { Agent, KvistcodeEvent } from "@/lib/types";
import { errorMessage } from "@/lib/utils";
import { useApp } from "./app";
import { useUi } from "./ui";

function handleUiEvent(e: KvistcodeEvent) {
  switch (e.type) {
    case "terminal_output":
      routeTerminalOutput(e.terminalId, e.data);
      break;
    case "terminal_exit":
      routeTerminalExit(e.terminalId, e.code);
      break;
    case "navigate": {
      const ui = useUi.getState();
      if (e.to.view === "agent") ui.openAgent(e.to.agentId);
      // "inbox" is the wire name the tray and the voice assistant still send for the Needs you tab.
      else if (e.to.view === "inbox") ui.openMission("needs");
      else if (e.to.view === "mission_control") ui.setView("mission");
      else if (e.to.view === "new_agent") ui.openNewAgent();
      break;
    }
    case "attention": {
      const ui = useUi.getState();
      // Don't toast about the agent the user is already looking at.
      if (ui.view === "agents" && ui.selectedAgentId === e.agentId && ui.windowFocused && e.reason !== "error") return;
      const action = e.agentId ? { label: "Open", onClick: () => useUi.getState().openAgent(e.agentId) } : undefined;
      const id = e.requestId ? `perm-${e.requestId}` : `attn-${e.agentId}-${e.reason}`;
      const opts = { description: e.body, action, id };
      if (e.reason === "permission") toast.warning(e.title, opts);
      else if (e.reason === "error") toast.error(e.title, opts);
      // The turn ended but launched work is still running: a plain message, not a green "success".
      else if (e.body.startsWith(TURN_ONLY_PREFIX) || isResumedBody(e.body)) toast(e.title, opts);
      else toast.success(e.title, opts);
      break;
    }
    case "item_upserted":
      // Drop the approval toast once the request is answered (here or elsewhere).
      if ((e.item.kind === "permission" || e.item.kind === "question") && e.item.resolution !== null)
        toast.dismiss(`perm-${e.item.requestId}`);
      break;
    case "schedule_updated":
      publishScheduleEvent({ type: "updated", schedule: e.schedule });
      break;
    case "schedule_removed":
      publishScheduleEvent({ type: "removed", scheduleId: e.scheduleId });
      break;
    case "agent_removed": {
      const ui = useUi.getState();
      if (ui.selectedAgentId === e.agentId)
        useUi.setState({ selectedAgentId: tileNeighbour(useApp.getState().agents, ui.tileGroup, e.agentId) });
      if (ui.reviewAgentId === e.agentId) useUi.setState({ reviewAgentId: null });
      break;
    }
    default:
      break;
  }
}

/** failover === "ask": offer a one-click move when an agent hits its usage limit. */
function offerFailover(agent: Agent) {
  if (useApp.getState().settings?.failover !== "ask") return;
  const target = switchCandidates(agent)[0];
  toast.warning(`${agent.title} hit its usage limit`, {
    id: `limit-${agent.id}`,
    duration: 15_000,
    description: target ? `Move it to ${target.name} and keep going?` : "No other signed-in account for this provider.",
    action: target
      ? { label: `Switch to ${target.name}`, onClick: () => void switchAccount(agent, target, true) }
      : { label: "Open", onClick: () => useUi.getState().openAgent(agent.id) },
  });
}

/** How long events wait for the next frame in a visible window before being applied anyway. */
const VISIBLE_FALLBACK_MS = 120;
/** A hidden window has no frames and nobody watching: events are applied in coarse batches (and at once on return). */
const HIDDEN_FLUSH_MS = 1000;

/** Subscribe the stores to backend events. Returns an unsubscribe function. */
export function connectEvents(): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  // Store-bound events are coalesced: everything that arrives within one animation frame
  // is applied in a single update (streaming can deliver hundreds of deltas per second).
  let queue: KvistcodeEvent[] = [];
  let raf = 0;
  let fallback: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (raf) cancelAnimationFrame(raf);
    if (fallback) clearTimeout(fallback);
    raf = 0;
    fallback = null;
    const batch = queue;
    queue = [];
    if (batch.length === 0) return;
    const before = useApp.getState().agents;
    useApp.getState().applyEvents(batch);
    for (const e of batch) {
      handleUiEvent(e);
      if (e.type === "agent_updated" && e.agent.rateLimited && before[e.agent.id] && !before[e.agent.id].rateLimited) {
        offerFailover(e.agent);
      }
    }
  };
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(flush);
    // rAF doesn't run while the window is hidden; don't let events pile up. Nobody is watching then, so the
    // batches are far apart: a hidden window with eight agents streaming costs one render a second, not eight.
    fallback = setTimeout(flush, document.hidden ? HIDDEN_FLUSH_MS : VISIBLE_FALLBACK_MS);
  };
  // Coming back: show everything that arrived meanwhile right away.
  const onVisible = () => {
    if (!document.hidden && queue.length > 0) flush();
  };
  document.addEventListener("visibilitychange", onVisible);

  void onKvistcodeEvent((e) => {
    // Terminal output is latency-sensitive and doesn't touch the store.
    if (e.type === "terminal_output" || e.type === "terminal_exit") {
      handleUiEvent(e);
      return;
    }
    queue.push(e);
    schedule();
  })
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch((e: unknown) => {
      // Without the event stream the UI silently goes stale: say so, persistently.
      if (!disposed) useApp.setState({ connectionLost: errorMessage(e) });
    });
  return () => {
    disposed = true;
    document.removeEventListener("visibilitychange", onVisible);
    if (raf) cancelAnimationFrame(raf);
    if (fallback) clearTimeout(fallback);
    unlisten?.();
  };
}
