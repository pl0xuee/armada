import { toast } from "sonner";
import { onArmadaEvent } from "@/lib/api";
import { publishScheduleEvent } from "@/lib/scheduleEvents";
import { routeTerminalExit, routeTerminalOutput } from "@/lib/terminal-bus";
import { switchAccount, switchCandidates } from "@/lib/actions";
import type { Agent, ArmadaEvent } from "@/lib/types";
import { errorMessage } from "@/lib/utils";
import { useApp } from "./app";
import { useUi } from "./ui";

function handleUiEvent(e: ArmadaEvent) {
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
      else if (e.to.view === "inbox") ui.setView("inbox");
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
      else toast.success(e.title, opts);
      break;
    }
    case "item_upserted":
      // Drop the approval toast once the request is answered (here or elsewhere).
      if ((e.item.kind === "permission" || e.item.kind === "question") && e.item.resolution !== null) toast.dismiss(`perm-${e.item.requestId}`);
      break;
    case "schedule_updated":
      publishScheduleEvent({ type: "updated", schedule: e.schedule });
      break;
    case "schedule_removed":
      publishScheduleEvent({ type: "removed", scheduleId: e.scheduleId });
      break;
    case "agent_removed": {
      const ui = useUi.getState();
      if (ui.selectedAgentId === e.agentId) useUi.setState({ selectedAgentId: null });
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

/** Subscribe the stores to backend events. Returns an unsubscribe function. */
export function connectEvents(): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  // Store-bound events are coalesced: everything that arrives within one animation frame
  // is applied in a single update (streaming can deliver hundreds of deltas per second).
  let queue: ArmadaEvent[] = [];
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
    // rAF doesn't run while the window is hidden; don't let events pile up.
    fallback = setTimeout(flush, 120);
  };

  void onArmadaEvent((e) => {
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
    if (raf) cancelAnimationFrame(raf);
    if (fallback) clearTimeout(fallback);
    unlisten?.();
  };
}
