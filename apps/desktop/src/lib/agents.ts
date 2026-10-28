import type { Account, Agent, TimelineItem } from "./types";

export type AgentGroupId = "needs" | "working" | "recent" | "archived";

export interface AgentGroup {
  id: AgentGroupId;
  label: string;
  agents: Agent[];
}

const NEEDS_RANK: Partial<Record<Agent["status"], number>> = {
  needs_permission: 0,
  error: 1,
  interrupted: 2,
};

export function groupAgents(agents: Agent[], query = ""): AgentGroup[] {
  const q = query.trim().toLowerCase();
  const match = (a: Agent) =>
    !q ||
    a.title.toLowerCase().includes(q) ||
    a.projectPath.toLowerCase().includes(q) ||
    (a.branch ?? "").toLowerCase().includes(q) ||
    (a.lastMessage ?? "").toLowerCase().includes(q);

  const needs: Agent[] = [];
  const working: Agent[] = [];
  const recent: Agent[] = [];
  const archived: Agent[] = [];
  for (const a of agents) {
    if (!match(a)) continue;
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

/** Flat order used by ⌘1..9 (archived excluded). */
export function orderedAgents(agents: Agent[]): Agent[] {
  return groupAgents(agents)
    .filter((g) => g.id !== "archived")
    .flatMap((g) => g.agents);
}

export function accountName(accounts: Account[], id: string): string {
  return accounts.find((a) => a.id === id)?.name ?? "Unknown account";
}

/** Files the agent touched, from tool call locations and diffs. */
export function filesTouched(items: TimelineItem[]): { path: string; edited: boolean; count: number }[] {
  const map = new Map<string, { path: string; edited: boolean; count: number }>();
  for (const it of items) {
    if (it.kind !== "tool_call") continue;
    const edited = it.toolKind === "edit" || it.toolKind === "delete" || it.toolKind === "move" || it.diffs.length > 0;
    const paths = new Set<string>([...it.locations, ...it.diffs.map((d) => d.path)]);
    for (const p of paths) {
      const cur = map.get(p) ?? { path: p, edited: false, count: 0 };
      cur.count++;
      cur.edited ||= edited;
      map.set(p, cur);
    }
  }
  return [...map.values()].sort((a, b) => Number(b.edited) - Number(a.edited) || a.path.localeCompare(b.path));
}

export function latestPlan(items: TimelineItem[]) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "plan") return it;
  }
  return null;
}

/** Short description of the agent's most recent action, for tiles. */
export function lastAction(items: TimelineItem[] | undefined): string | null {
  if (!items) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "tool_call") return it.title;
    if (it.kind === "permission" && it.resolution === null) return `Waiting: ${it.title}`;
  }
  return null;
}

export function isBusy(a: Agent) {
  return a.status === "working" || a.status === "starting" || a.status === "needs_permission";
}
