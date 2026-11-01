import { useMemo } from "react";
import { triageQueue } from "@/lib/agents";
import type { Agent, AgentStatus } from "@/lib/types";
import { useApp } from "@/store/app";

/** Agents that are working or about to (a pending approval counts: the agent is paused, not done). */
export const LIVE: AgentStatus[] = ["working", "starting", "needs_permission"];
const IDLE: AgentStatus[] = ["idle", "stopped"];

export type Filter = "all" | "live" | "idle";

export function matchesFilter(a: Agent, f: Filter): boolean {
  if (f === "live") return LIVE.includes(a.status);
  if (f === "idle") return IDLE.includes(a.status);
  return true;
}

const STATUS_ORDER: Record<AgentStatus, number> = {
  needs_permission: 0,
  working: 1,
  starting: 2,
  error: 3,
  interrupted: 4,
  idle: 5,
  stopped: 6,
};

/**
 * Every agent that isn't archived, in a stable order: the ones that need you first (same order as the
 * Needs you tab), then by status group, then creation time. (Sorting by activity made tiles jump on
 * every cost/token tick.)
 */
export function useFleet(): { agents: Agent[]; live: number; idle: number } {
  const agentsMap = useApp((s) => s.agents);
  return useMemo(() => {
    const active = Object.values(agentsMap).filter((a) => !a.archived);
    const urgent = triageQueue(active).map((e) => e.agent);
    const urgentIds = new Set(urgent.map((a) => a.id));
    const rest = active
      .filter((a) => !urgentIds.has(a.id))
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.createdAt - a.createdAt);
    return {
      agents: [...urgent, ...rest],
      live: active.filter((a) => matchesFilter(a, "live")).length,
      idle: active.filter((a) => matchesFilter(a, "idle")).length,
    };
  }, [agentsMap]);
}
