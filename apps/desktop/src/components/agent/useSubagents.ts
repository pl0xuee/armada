// Live sub-agent data for the list badge, header popover and title-bar indicator. Everything goes
// through `agentDerived` (cached per agent by tool-call structure), and idle agents are skipped
// outright, so streamed deltas never trigger a scan of other agents' timelines.
import { useSyncExternalStore } from "react";
import { isBusy, isSubagentLive, SUBAGENT_TICK_MS, type SubagentRun } from "@/lib/agents";
import type { Agent } from "@/lib/types";
import { useApp, type AppStore } from "@/store/app";
import { agentDerived } from "./derived";

// One shared slow ticker for the time-based background sub-agent rules. It only runs while a
// component is subscribed, and a subscriber re-renders only when its derived value changes.
const tickSubs = new Set<() => void>();
let tickTimer: ReturnType<typeof setInterval> | null = null;

function subscribeTicked(cb: () => void) {
  tickSubs.add(cb);
  const unsub = useApp.subscribe(cb);
  tickTimer ??= setInterval(() => {
    for (const s of tickSubs) s();
  }, SUBAGENT_TICK_MS);
  return () => {
    unsub();
    tickSubs.delete(cb);
    if (tickSubs.size === 0 && tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };
}

const bucketNow = () => Math.floor(Date.now() / SUBAGENT_TICK_MS) * SUBAGENT_TICK_MS;

/** `useApp(select)` that also re-evaluates on the sub-agent clock; `select` gets the bucketed time. */
export function useTickedApp<T>(select: (s: AppStore, now: number) => T): T {
  return useSyncExternalStore(subscribeTicked, () => select(useApp.getState(), bucketNow()));
}

/** Derived sub-agent data for one agent at time `now`. */
export function subagentDerived(s: AppStore, agent: Agent, now: number) {
  return agentDerived(agent.id, s.items[agent.id], isBusy(agent), { now, live: isSubagentLive(agent.status) });
}

export interface AgentSubagents {
  agent: Agent;
  /** Running first (launch order), then finished this turn. */
  runs: SubagentRun[];
  running: number;
}

export interface SubagentOverview {
  total: number;
  agents: AgentSubagents[];
}

const NONE: SubagentOverview = { total: 0, agents: [] };
let last: SubagentOverview = NONE;

function sameOverview(a: SubagentOverview, b: SubagentOverview): boolean {
  if (a.total !== b.total || a.agents.length !== b.agents.length) return false;
  return a.agents.every((x, i) => {
    const y = b.agents[i];
    return x.agent.id === y.agent.id && x.agent.title === y.agent.title && x.runs === y.runs;
  });
}

/** Every agent with running sub-agents. A stable reference while nothing relevant changed. */
export function useSubagentOverview(): SubagentOverview {
  return useTickedApp((s, now) => {
    const agents: AgentSubagents[] = [];
    let total = 0;
    for (const agent of Object.values(s.agents)) {
      if (!isSubagentLive(agent.status)) continue;
      const d = subagentDerived(s, agent, now);
      if (d.runningSubagents === 0) continue;
      total += d.runningSubagents;
      agents.push({ agent, runs: d.subagents, running: d.runningSubagents });
    }
    if (total === 0) return (last = NONE);
    agents.sort((a, b) => a.agent.title.localeCompare(b.agent.title));
    const next = { total, agents };
    if (sameOverview(last, next)) return last;
    return (last = next);
  });
}

/** Running sub-agent count for one agent (0 unless it can still be waiting on them). */
export function useRunningSubagentCount(agentId: string): number {
  return useTickedApp((s, now) => {
    const agent = s.agents[agentId];
    if (!agent || !isSubagentLive(agent.status)) return 0;
    return subagentDerived(s, agent, now).runningSubagents;
  });
}

/** The agent's sub-agent runs (running first-class), clock-aware. */
export function useSubagentRuns(agentId: string): SubagentRun[] {
  return useTickedApp((s, now) => {
    const agent = s.agents[agentId];
    if (!agent || !isSubagentLive(agent.status)) return NO_RUNS;
    return subagentDerived(s, agent, now).subagents;
  });
}

const NO_RUNS: SubagentRun[] = [];
