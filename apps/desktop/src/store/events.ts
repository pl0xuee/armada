import { toast } from "sonner";
import { onArmadaEvent } from "@/lib/api";
import { routeTerminalExit, routeTerminalOutput } from "@/lib/terminal-bus";
import { switchAccount, switchCandidates } from "@/lib/actions";
import type { Agent, ArmadaEvent } from "@/lib/types";
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
      if (e.item.kind === "permission" && e.item.resolution !== null) toast.dismiss(`perm-${e.item.requestId}`);
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
  void onArmadaEvent((e) => {
    const prev = e.type === "agent_updated" ? useApp.getState().agents[e.agent.id] : undefined;
    useApp.getState().applyEvent(e);
    handleUiEvent(e);
    if (e.type === "agent_updated" && e.agent.rateLimited && prev && !prev.rateLimited) offerFailover(e.agent);
  }).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}
