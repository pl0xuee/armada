// Live sub-agent data for the list badge, header popover and title-bar indicator. Everything goes
// through `agentDerived` (cached per agent by tool-call structure), and idle agents are skipped
// outright, so streamed deltas never trigger a scan of other agents' timelines.
import { isBusy, type SubagentRun } from "@/lib/agents";
import type { Agent } from "@/lib/types";
import { useApp } from "@/store/app";
import { agentDerived } from "./derived";

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
  return useApp((s) => {
    const agents: AgentSubagents[] = [];
    let total = 0;
    for (const agent of Object.values(s.agents)) {
      if (!isBusy(agent)) continue;
      const d = agentDerived(agent.id, s.items[agent.id], true);
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

/** Running sub-agent count for one agent (0 unless it is busy). */
export function useRunningSubagentCount(agentId: string): number {
  return useApp((s) => {
    const agent = s.agents[agentId];
    if (!agent || !isBusy(agent)) return 0;
    return agentDerived(agentId, s.items[agentId], true).runningSubagents;
  });
}
