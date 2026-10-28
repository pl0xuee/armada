import { useMemo } from "react";
import { useStore, type Timeline } from "./store";
import type { Agent, PermissionItem } from "./types";

/** Approvals still waiting for this agent, net of answers we've just sent. */
export function pendingCount(agent: Agent, timeline: Timeline | undefined, resolving: Record<string, string>): number {
  if (agent.pendingPermissions <= 0) return 0;
  if (!timeline || timeline.status !== "ready") return agent.pendingPermissions;
  let n = 0;
  for (const it of timeline.items) {
    if (it.kind === "permission" && it.resolution === null && !resolving[it.requestId]) n++;
  }
  return Math.min(n, agent.pendingPermissions);
}

export interface InboxEntry {
  agent: Agent;
  item: PermissionItem;
}

export interface InboxData {
  entries: InboxEntry[];
  /** Agents with approvals whose timelines are still loading. */
  loading: number;
  /** Agents with approvals whose timelines failed to load. */
  failed: Agent[];
  count: number;
}

export function useInbox(): InboxData {
  const agents = useStore((s) => s.agents);
  const timelines = useStore((s) => s.timelines);
  const resolving = useStore((s) => s.resolving);
  return useMemo(() => {
    const entries: InboxEntry[] = [];
    const failed: Agent[] = [];
    let loading = 0;
    let count = 0;
    for (const agent of Object.values(agents)) {
      if (agent.archived || agent.pendingPermissions <= 0) continue;
      const t = timelines[agent.id];
      count += pendingCount(agent, t, resolving);
      if (!t || t.status === "loading") {
        loading++;
        continue;
      }
      if (t.status === "error") {
        failed.push(agent);
        continue;
      }
      for (const it of t.items) {
        if (it.kind === "permission" && it.resolution === null) entries.push({ agent, item: it });
      }
    }
    entries.sort((a, b) => a.item.ts - b.item.ts);
    return { entries, loading, failed, count };
  }, [agents, timelines, resolving]);
}

export type FleetGroupId = "needs" | "working" | "recent" | "archived";

export interface FleetGroup {
  id: FleetGroupId;
  label: string;
  agents: Agent[];
}

const NEEDS_RANK: Partial<Record<Agent["status"], number>> = { needs_permission: 0, error: 1, interrupted: 2 };

/** Same grouping as the desktop sidebar: needs you, working, recent, archived. */
export function groupFleet(agents: Agent[]): FleetGroup[] {
  const needs: Agent[] = [];
  const working: Agent[] = [];
  const recent: Agent[] = [];
  const archived: Agent[] = [];
  for (const a of agents) {
    if (a.archived) archived.push(a);
    else if (a.status in NEEDS_RANK || a.pendingPermissions > 0) needs.push(a);
    else if (a.status === "working" || a.status === "starting") working.push(a);
    else recent.push(a);
  }
  const byActivity = (x: Agent, y: Agent) => y.lastActivityAt - x.lastActivityAt;
  needs.sort((x, y) => (NEEDS_RANK[x.status] ?? 0) - (NEEDS_RANK[y.status] ?? 0) || byActivity(x, y));
  working.sort(byActivity);
  recent.sort(byActivity);
  archived.sort(byActivity);
  return [
    { id: "needs", label: "Needs you", agents: needs },
    { id: "working", label: "Working", agents: working },
    { id: "recent", label: "Recent", agents: recent },
    { id: "archived", label: "Archived", agents: archived },
  ];
}
