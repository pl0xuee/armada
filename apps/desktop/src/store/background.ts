import { create } from "zustand";
import { agentDerived } from "@/components/agent/derived";
import { api } from "@/lib/api";
import { ALERT_SETTLE_MS, NotifiedRuns, workflowFinishedDetail } from "@/lib/finishedAlert";
import { isBusy, isSubagentLive, SUBAGENT_TICK_MS } from "@/lib/agents";
import {
  backgroundActive,
  backgroundDetail,
  backgroundPill,
  backgroundShort,
  computeBackground,
  needsWatch,
  NO_BACKGROUND,
  setBackgroundWork,
  type BackgroundWork,
} from "@/lib/background";
import { DONE_META, STATUS, type StatusMeta } from "@/lib/providers";
import type { Agent, AgentStatus } from "@/lib/types";
import {
  pollWorkflowNow,
  recheckWorkflow,
  useWorkflows,
  watchWorkflow,
  workflowKey,
  type WorkflowCall,
} from "@/lib/workflows";
import { useApp } from "./app";
import { useIsDone } from "./completion";
import { useUi } from "./ui";

/**
 * Background work per agent (see lib/background.ts), kept up to date by `installBackgroundTracker`
 * for every agent, selected or not. Rows and tiles just read their entry: no timers or scans per row.
 */
export const useBackgroundStore = create<{
  byAgent: Record<string, BackgroundWork>;
  /** Agents with background work, a new set only when membership changes. */
  active: ReadonlySet<string>;
  /** When all of an agent's background work ended after its turn did ("Everything finished"). */
  finishedAt: Record<string, number>;
}>(() => ({ byAgent: {}, active: new Set(), finishedAt: {} }));

export const useBackground = (agentId: string): BackgroundWork =>
  useBackgroundStore((s) => s.byAgent[agentId] ?? NO_BACKGROUND);

export const useBackgroundIds = () => useBackgroundStore((s) => s.active);

/** What an agent's status reads as, once background work is taken into account. */
export interface StatusView {
  done: boolean;
  meta: StatusMeta;
  /** The status to draw the dot with ("working" while only background work runs). */
  dot: AgentStatus;
  bg: BackgroundWork;
  /** The turn has ended but background work is still running. */
  background: boolean;
  /** Longer wording for a tooltip (null: nothing to add). */
  detail: string | null;
  /** Header pill text: names what finished and what did not. */
  pill: string;
}

/** Pure part of `useStatusView`. */
export function statusView(agent: Agent, marked: boolean, bg: BackgroundWork): StatusView {
  const idle = agent.status === "idle";
  const background = idle && backgroundActive(bg);
  const done = idle && !background && (marked || agent.unread);
  if (background) {
    return {
      done: false,
      meta: { label: backgroundShort(bg), colorVar: "var(--accent)", live: true },
      dot: "working",
      bg,
      background,
      detail: backgroundDetail(bg),
      pill: backgroundPill(bg),
    };
  }
  const meta = done ? DONE_META : STATUS[agent.status];
  return { done, meta, dot: agent.status, bg, background, detail: null, pill: meta.label };
}

/** Done / working / idle for one agent, with background work counted as working. */
export function useStatusView(agent: Agent): StatusView {
  const done = useIsDone(agent);
  const bg = useBackground(agent.id);
  return statusView(agent, done, bg);
}

// ---- tracker ------------------------------------------------------------------------------------

/**
 * While the window is blurred the shared poller rests; a run already known to be running is still
 * checked this often so the "everything finished" alert can reach someone who stepped away. 0 turns it off.
 */
export const BLURRED_CHECK_MS = 30_000;

const bucketNow = () => Math.floor(Date.now() / SUBAGENT_TICK_MS) * SUBAGENT_TICK_MS;
const blurred = () => document.documentElement.dataset.window === "blurred" || document.hidden;

/** Said to the user only when they aren't looking at the agent. */
function watching(agentId: string): boolean {
  const ui = useUi.getState();
  return ui.view === "agents" && ui.windowFocused && ui.selectedAgentId === agentId;
}

/**
 * Keeps `useBackgroundStore` current. Reads each agent's launched Workflow runs (joining the shared
 * poller only for runs not yet finished, and only while the window is focused) and its background
 * sub-agents. Work is per agent whose items or status changed; the only timer runs while some agent
 * has background sub-agents (their rules are time based), and not while the window is blurred.
 */
export function installBackgroundTracker(): () => void {
  /** `agentId\0toolCallId` → leave the shared poller. */
  const joined = new Map<string, () => void>();
  const callsOf = new Map<string, string[]>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let awayTimer: ReturnType<typeof setInterval> | null = null;
  let prevAgents = useApp.getState().agents;
  let prevItems = useApp.getState().items;
  // "Everything finished" alerts: only for runs seen running in this session, once per run (kept across
  // restarts), and only once a run has stayed finished for a minute (a quiet spell is not the end).
  const notified = new NotifiedRuns();
  const seenRunning = new Set<string>();
  const settling = new Map<string, ReturnType<typeof setTimeout>>();

  const leave = (key: string) => {
    joined.get(key)?.();
    joined.delete(key);
  };

  function forget(id: string) {
    for (const tc of callsOf.get(id) ?? []) leave(workflowKey(id, tc));
    callsOf.delete(id);
  }

  function recompute(id: string) {
    const s = useApp.getState();
    const agent = s.agents[id];
    if (!agent || agent.archived || !isSubagentLive(agent.status)) {
      forget(id);
      commit(id, NO_BACKGROUND, agent);
      return;
    }
    const items = s.items[id];
    // Timelines are loaded on demand: a working agent's is fetched now (so a workflow it launches is
    // seen even if nobody opened it); an idle one that was never loaded has nothing known.
    if (!items) {
      if (isBusy(agent)) void s.ensureItems(id);
      return;
    }
    const d = agentDerived(id, items, isBusy(agent), { now: bucketNow(), live: true });
    const entries = useWorkflows.getState().byKey;
    // Join the shared poller for runs that may still be going; leave those that finished.
    const want = new Set<string>();
    for (const c of d.workflows) {
      const key = workflowKey(id, c.toolCallId);
      if (needsWatch(entries[key])) {
        want.add(key);
        if (!joined.has(key)) joined.set(key, watchWorkflow(id, c.toolCallId));
      }
    }
    for (const tc of callsOf.get(id) ?? []) {
      const key = workflowKey(id, tc);
      if (!want.has(key)) leave(key);
    }
    callsOf.set(
      id,
      d.workflows.map((c) => c.toolCallId),
    );
    const subs = d.subagents.filter((r) => r.background && r.state === "running").length;
    const ended = d.workflows.some((c) => entries[workflowKey(id, c.toolCallId)]?.progress?.state === "finished");
    const endedCalls = d.workflows.filter((c) => {
      const key = workflowKey(id, c.toolCallId);
      const state = entries[key]?.progress?.state;
      if (state === "running") seenRunning.add(key);
      return state === "finished" && seenRunning.has(key) && !notified.has(key);
    });
    commit(id, computeBackground(id, d.workflows, entries, subs), agent, ended, endedCalls);
  }

  function commit(id: string, next: BackgroundWork, agent: Agent | undefined, ended = false, endedCalls: WorkflowCall[] = []) {
    const st = useBackgroundStore.getState();
    const before = st.byAgent[id] ?? NO_BACKGROUND;
    const patch: Partial<ReturnType<typeof useBackgroundStore.getState>> = {};
    if (before !== next) {
      const byAgent = { ...st.byAgent };
      if (next === NO_BACKGROUND) delete byAgent[id];
      else byAgent[id] = next;
      patch.byAgent = byAgent;
      if (backgroundActive(before) !== backgroundActive(next)) {
        const active = new Set(st.active);
        if (backgroundActive(next)) active.add(id);
        else active.delete(id);
        patch.active = active;
        setBackgroundWork(id, backgroundActive(next));
      }
    }
    // A new turn (the agent is busy again) clears the "Everything finished" note.
    if (agent && isBusy(agent) && st.finishedAt[id] !== undefined) {
      const finishedAt = { ...st.finishedAt };
      delete finishedAt[id];
      patch.finishedAt = finishedAt;
    }
    // The last known work ended while the agent sat idle: say so (and tell the user, if away).
    if (ended && before.workflows > 0 && !backgroundActive(next) && agent?.status === "idle") {
      patch.finishedAt = { ...(patch.finishedAt ?? st.finishedAt), [id]: Date.now() };
      for (const call of endedCalls) settleAlert(id, call);
    }
    if (Object.keys(patch).length > 0) useBackgroundStore.setState(patch);
    syncTimer();
  }

  /** Announces `call` once it has stayed finished for a minute, if the user isn't looking at the agent. */
  function settleAlert(id: string, call: WorkflowCall) {
    const key = workflowKey(id, call.toolCallId);
    if (settling.has(key) || notified.has(key)) return;
    settling.set(
      key,
      setTimeout(() => {
        void (async () => {
          // Finished is final for the poller, so ask afresh: a run that moved again is not the end.
          const progress = await recheckWorkflow(id, call.toolCallId);
          settling.delete(key);
          const agent = useApp.getState().agents[id];
          if (!agent || agent.status !== "idle" || progress?.state !== "finished" || notified.has(key)) return;
          notified.add(key);
          if (watching(id)) return;
          const item = useApp.getState().items[id]?.find((i) => i.id === call.itemId);
          const description = item?.kind === "tool_call" ? (item.subagent?.description ?? null) : null;
          api
            .backgroundFinished(id, progress.agents.length || null, workflowFinishedDetail(description, progress.agents))
            .catch(() => {});
        })();
      }, ALERT_SETTLE_MS),
    );
  }

  function syncTimer() {
    const all = Object.values(useBackgroundStore.getState().byAgent);
    const need = all.some((b) => b.subagents > 0);
    if (need && !timer) timer = setInterval(tick, SUBAGENT_TICK_MS);
    else if (!need && timer) {
      clearInterval(timer);
      timer = null;
    }
    const away = BLURRED_CHECK_MS > 0 && all.some((b) => b.workflows > 0);
    if (away && !awayTimer) awayTimer = setInterval(checkAway, BLURRED_CHECK_MS);
    else if (!away && awayTimer) {
      clearInterval(awayTimer);
      awayTimer = null;
    }
  }

  // Blurred: read the runs known to be running (the shared poller is resting); the reports land in
  // useWorkflows and recompute the agent like any other.
  function checkAway() {
    if (!blurred()) return;
    for (const [id, tcs] of callsOf)
      for (const tc of tcs)
        if (useWorkflows.getState().byKey[workflowKey(id, tc)]?.progress?.state === "running") pollWorkflowNow(id, tc);
  }

  // Sub-agents expire by the clock; re-judge only the agents that have some.
  function tick() {
    if (blurred()) return;
    for (const [id, b] of Object.entries(useBackgroundStore.getState().byAgent)) if (b.subagents > 0) recompute(id);
  }

  const onWake = () => {
    if (!blurred()) tick();
  };
  window.addEventListener("focus", onWake);

  const offApp = useApp.subscribe((s) => {
    if (s.agents === prevAgents && s.items === prevItems) return;
    const agents = s.agents;
    const items = s.items;
    for (const id of Object.keys(agents)) {
      if (items[id] !== prevItems[id] || agents[id]?.status !== prevAgents[id]?.status) recompute(id);
    }
    for (const id of Object.keys(prevAgents)) if (!agents[id]) recompute(id);
    prevAgents = agents;
    prevItems = items;
  });

  // A report arrived: re-count the agents whose runs it belongs to.
  const offWf = useWorkflows.subscribe((s, p) => {
    if (s.byKey === p.byKey) return;
    for (const id of [...callsOf.keys()]) recompute(id);
  });

  for (const id of Object.keys(prevAgents)) recompute(id);

  return () => {
    offApp();
    offWf();
    window.removeEventListener("focus", onWake);
    if (timer) clearInterval(timer);
    if (awayTimer) clearInterval(awayTimer);
    for (const key of [...joined.keys()]) leave(key);
    callsOf.clear();
    for (const t of settling.values()) clearTimeout(t);
    settling.clear();
    useBackgroundStore.setState({ byAgent: {}, active: new Set(), finishedAt: {} });
  };
}
