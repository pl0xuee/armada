import { useMemo } from "react";
import { useStore, type State } from "./store";
import type { Agent, PendingItem, RemoteAccount } from "./types";

/** The agent's account, if known (share links don't include accounts). */
export function accountOf(accounts: Record<string, RemoteAccount>, agent: Pick<Agent, "accountId">): RemoteAccount | undefined {
  return agent.accountId ? accounts[agent.accountId] : undefined;
}

/** Pending approvals grouped by agent (memoised on the permissions slice). */
let indexMemo: { permissions: State["permissions"]; index: Map<string, PendingItem[]> } | null = null;
export function permissionIndex(permissions: State["permissions"]): Map<string, PendingItem[]> {
  if (indexMemo && indexMemo.permissions === permissions) return indexMemo.index;
  const index = new Map<string, PendingItem[]>();
  for (const p of Object.values(permissions)) {
    if (p.resolution !== null) continue;
    const list = index.get(p.agentId);
    if (list) list.push(p);
    else index.set(p.agentId, [p]);
  }
  for (const list of index.values()) list.sort((a, b) => a.ts - b.ts);
  indexMemo = { permissions, index };
  return index;
}

/**
 * Approvals still waiting for this agent, net of answers being sent. Uses the
 * permissions list once loaded (the agent's own counter until then); an agent
 * whose counter is 0 never shows stale items.
 */
export function pendingCount(
  agent: Agent,
  items: PendingItem[] | undefined,
  loaded: boolean,
  resolving: Record<string, string>,
): number {
  if (agent.pendingPermissions <= 0) return 0;
  if (!loaded) return agent.pendingPermissions;
  let n = 0;
  for (const it of items ?? []) if (!resolving[it.requestId]) n++;
  return Math.min(n, agent.pendingPermissions);
}

export interface InboxEntry {
  agent: Agent;
  item: PendingItem;
}

export interface InboxData {
  entries: InboxEntry[];
  /** The permissions list is still loading. */
  loading: boolean;
  /** Loading the permissions list failed. */
  failed: boolean;
  count: number;
  /** How many of the entries are questions (the rest are approvals). */
  questions: number;
}

/** "2 approvals waiting", "1 question waiting", or "3 requests waiting" when mixed. */
export function waitingLabel(count: number, questions: number): string {
  const noun = questions === 0 ? "approval" : questions >= count ? "question" : "request";
  return `${count} ${noun}${count === 1 ? "" : "s"} waiting`;
}

let countMemo: {
  agents: State["agents"];
  permissions: State["permissions"];
  status: State["permissionsStatus"];
  resolving: State["resolving"];
  count: number;
} | null = null;

/**
 * Total approvals waiting, memoised on the slices it reads. Returning a
 * number lets subscribers (title, badges) skip re-rendering when it's unchanged,
 * e.g. on every streamed text chunk.
 */
export function selectInboxCount(s: State): number {
  if (
    countMemo &&
    countMemo.agents === s.agents &&
    countMemo.permissions === s.permissions &&
    countMemo.status === s.permissionsStatus &&
    countMemo.resolving === s.resolving
  ) {
    return countMemo.count;
  }
  const index = permissionIndex(s.permissions);
  const loaded = s.permissionsStatus === "ready";
  let count = 0;
  for (const agent of Object.values(s.agents)) {
    if (agent.archived) continue;
    count += pendingCount(agent, index.get(agent.id), loaded, s.resolving);
  }
  countMemo = { agents: s.agents, permissions: s.permissions, status: s.permissionsStatus, resolving: s.resolving, count };
  return count;
}

export function useInboxCount(): number {
  return useStore(selectInboxCount);
}

/** Pending approvals for one agent (for its row badge). */
export function useAgentPending(agent: Agent): number {
  return useStore((s) =>
    pendingCount(agent, permissionIndex(s.permissions).get(agent.id), s.permissionsStatus === "ready", s.resolving),
  );
}

/** Is this agent waiting on a question (rather than an approval)? */
export function useAgentAsking(agentId: string): boolean {
  return useStore((s) => pendingKindOf(permissionIndex(s.permissions).get(agentId)) === "question");
}

/** Approvals waiting on other agents than `agentId`. */
export function useOtherPendingCount(agentId: string | null): number {
  return useStore((s) => {
    const total = selectInboxCount(s);
    const a = agentId ? s.agents[agentId] : undefined;
    if (!a || a.archived) return total;
    return total - pendingCount(a, permissionIndex(s.permissions).get(a.id), s.permissionsStatus === "ready", s.resolving);
  });
}

export function useInbox(): InboxData {
  const agents = useStore((s) => s.agents);
  const permissions = useStore((s) => s.permissions);
  const status = useStore((s) => s.permissionsStatus);
  const resolving = useStore((s) => s.resolving);
  return useMemo(() => {
    const index = permissionIndex(permissions);
    const loaded = status === "ready";
    const entries: InboxEntry[] = [];
    let count = 0;
    for (const agent of Object.values(agents)) {
      if (agent.archived || agent.pendingPermissions <= 0) continue;
      const items = index.get(agent.id);
      count += pendingCount(agent, items, loaded, resolving);
      for (const item of items ?? []) entries.push({ agent, item });
    }
    entries.sort((a, b) => a.item.ts - b.item.ts);
    const questions = entries.filter((e) => e.item.kind === "question").length;
    return { entries, loading: !loaded && status !== "error" && count > 0, failed: status === "error", count, questions };
  }, [agents, permissions, status, resolving]);
}

export type FleetGroupId = "needs" | "working" | "recent" | "archived";

export interface FleetGroup {
  id: FleetGroupId;
  label: string;
  agents: Agent[];
}

const NEEDS_RANK: Partial<Record<Agent["status"], number>> = { needs_permission: 0, error: 1, interrupted: 2 };

/**
 * Does this (live) agent need the owner? Waiting on an approval, stopped by an
 * error or interruption, or out of usage: a rate-limited agent always needs
 * you, even if its status has already moved on from "error".
 */
export function needsYou(a: Agent): boolean {
  return a.status in NEEDS_RANK || a.pendingPermissions > 0 || a.rateLimited === true;
}

export const USAGE_LIMIT_LABEL = "Usage limit";

/**
 * The last turn hit the account's usage limit and the agent isn't doing anything
 * else: a warning ("Usage limit"), not a failure, and the fix is switching accounts.
 */
export function isUsageLimited(a: Pick<Agent, "rateLimited" | "status">): boolean {
  return a.rateLimited === true && a.status !== "working" && a.status !== "starting" && a.status !== "needs_permission";
}

/** What an agent is waiting on: only questions, or (at least partly) approvals. */
export function pendingKindOf(items: readonly PendingItem[] | undefined): "question" | "permission" | null {
  if (!items?.length) return null;
  return items.every((i) => i.kind === "question") ? "question" : "permission";
}

/** Approvals first, then errors (a usage limit is one), then interrupted. */
function needsRank(a: Agent): number {
  return NEEDS_RANK[a.status] ?? (a.rateLimited === true ? NEEDS_RANK.error! : 0);
}

/** Same grouping as the desktop sidebar: needs you, working, recent, archived. */
export function groupFleet(agents: Agent[]): FleetGroup[] {
  const needs: Agent[] = [];
  const working: Agent[] = [];
  const recent: Agent[] = [];
  const archived: Agent[] = [];
  for (const a of agents) {
    if (a.archived) archived.push(a);
    else if (needsYou(a)) needs.push(a);
    else if (a.status === "working" || a.status === "starting") working.push(a);
    else recent.push(a);
  }
  const byActivity = (x: Agent, y: Agent) => y.lastActivityAt - x.lastActivityAt;
  needs.sort((x, y) => needsRank(x) - needsRank(y) || byActivity(x, y));
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

/** Same matching as the desktop sidebar: title, project, branch, last message. */
export function filterAgents(agents: Agent[], query: string): Agent[] {
  const q = query.trim().toLowerCase();
  if (!q) return agents;
  return agents.filter(
    (a) =>
      a.title.toLowerCase().includes(q) ||
      (a.projectPath ?? "").toLowerCase().includes(q) ||
      (a.branch ?? "").toLowerCase().includes(q) ||
      (a.lastMessage ?? "").toLowerCase().includes(q),
  );
}
