import { create } from "zustand";
import { api } from "@/lib/api";
import { LONG_TURN_MS, turnOutcome, turnStart } from "@/components/timeline/thinking";
import type { Agent, AgentStatus } from "@/lib/types";
import { useApp } from "./app";
import { useUi } from "./ui";

/**
 * Agents whose last turn just completed ("Done" pill). Cleared by the next prompt (status leaves
 * idle) or when the user leaves the agent. Presentation only; AgentStatus is unchanged.
 */
export const useCompletion = create<{ done: Record<string, true> }>(() => ({ done: {} }));

const busy = (s: AgentStatus) => s === "working" || s === "starting";

function setDone(id: string, on: boolean) {
  const cur = useCompletion.getState().done;
  if (on === !!cur[id]) return;
  const next = { ...cur };
  if (on) next[id] = true;
  else delete next[id];
  useCompletion.setState({ done: next });
}

/** Shown as "Done": just finished a turn here, or finished while you were away (unread). */
export function isDone(agent: Agent, marked: boolean): boolean {
  return agent.status === "idle" && (marked || agent.unread);
}

export function useIsDone(agent: Agent): boolean {
  const marked = useCompletion((s) => !!s.done[agent.id]);
  return isDone(agent, marked);
}

/** Watches agent status transitions. Call once at startup; returns the unsubscribe. */
export function installCompletionTracker(): () => void {
  let prev: Record<string, AgentStatus> = {};
  for (const a of Object.values(useApp.getState().agents)) prev[a.id] = a.status;

  const offApp = useApp.subscribe((s, p) => {
    if (s.agents === p.agents) return;
    const nextPrev: Record<string, AgentStatus> = {};
    for (const a of Object.values(s.agents)) {
      nextPrev[a.id] = a.status;
      const before = prev[a.id];
      if (a.status !== "idle") setDone(a.id, false);
      if (before && busy(before) && a.status === "idle") {
        const items = s.items[a.id] ?? [];
        if (turnOutcome(items) === "done") {
          setDone(a.id, true);
          maybeChime(a, items);
        }
      }
    }
    prev = nextPrev;
  });

  const offUi = useUi.subscribe((s, p) => {
    if (p.selectedAgentId && p.selectedAgentId !== s.selectedAgentId) setDone(p.selectedAgentId, false);
  });
  return () => {
    offApp();
    offUi();
  };
}

function maybeChime(agent: Agent, items: Parameters<typeof turnStart>[0]) {
  const ui = useUi.getState();
  const settings = useApp.getState().settings;
  if (!settings) return;
  const watching = ui.view === "agents" && ui.windowFocused && ui.selectedAgentId === agent.id;
  if (!watching || !settings.notifications.smartMute || !settings.sounds.chimeWhenWatching) return;
  const now = Date.now();
  if (now - turnStart(items, now) < LONG_TURN_MS) return;
  api.chimeWatched().catch(() => {});
}
