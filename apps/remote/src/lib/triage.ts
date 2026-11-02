/**
 * "Needs you": the one definition of which agents wait on the owner, and how they are ordered and
 * grouped. The phone's copy of the desktop's `needsAttention` / `triageQueue` / `groupByProject`
 * (`apps/desktop/src/lib/agents.ts`): the rail badge there, the badge, callout and queue here, and the
 * page title all count the same agents, so they cannot disagree.
 */
import { basename } from "./format";
import type { Agent } from "./types";

export type NeedsReason = "permission" | "budget" | "rate_limited" | "error" | "done";

/**
 * Why an agent needs the owner, or null. `pending` is the number of approvals/questions still open once
 * answers being sent are subtracted (undefined: use the agent's own counter). An answer on its way
 * already counts as given, so a card leaves the queue the moment it is answered.
 */
export function needsReason(a: Agent, pending?: number, background = false): NeedsReason | null {
  if (a.archived) return null;
  // Every open request was just answered here: the status that still says "waiting" is stale.
  const answered = pending !== undefined && a.pendingPermissions > 0 && pending === 0;
  // An approval is still blocking, even if the agent was marked done.
  if (!answered && (a.pendingPermissions > 0 || a.status === "needs_permission")) return "permission";
  // Held at a limit: stays until the owner chooses, like an approval ("Done" doesn't dismiss it).
  if (a.budgetHold) return "budget";
  // "Done" dismisses until the agent does something new.
  if (a.acknowledgedAt != null && a.acknowledgedAt >= a.lastActivityAt) return null;
  if (a.rateLimited) return "rate_limited";
  if (a.status === "error") return "error";
  // Its turn ended but a workflow it started still runs: not finished yet, so nothing to review.
  if (background) return null;
  if (a.unread && (a.status === "idle" || a.status === "stopped" || a.status === "interrupted")) return "done";
  return null;
}

/** Most urgent first. */
export const NEED_RANK: Record<NeedsReason, number> = { permission: 0, budget: 1, rate_limited: 2, error: 3, done: 4 };

export interface TriageEntry {
  agent: Agent;
  reason: NeedsReason;
}

/** Agents that need the owner, most urgent reason first, then the one waiting longest. */
export function triageQueue(
  agents: readonly Agent[],
  pendingOf?: (a: Agent) => number | undefined,
  backgroundOf?: (a: Agent) => boolean,
): TriageEntry[] {
  const out: TriageEntry[] = [];
  for (const agent of agents) {
    const reason = needsReason(agent, pendingOf?.(agent), backgroundOf?.(agent));
    if (reason) out.push({ agent, reason });
  }
  return out.sort((a, b) => NEED_RANK[a.reason] - NEED_RANK[b.reason] || a.agent.lastActivityAt - b.agent.lastActivityAt);
}

export interface TriageSection {
  id: "blocked" | "review";
  label: string;
  entries: TriageEntry[];
}

/** Agents stuck on the owner are "Blocked"; finished work waiting to be looked at is "To review". Empty sections are omitted. */
export function triageSections(queue: readonly TriageEntry[]): TriageSection[] {
  const blocked = queue.filter((e) => e.reason !== "done");
  const review = queue.filter((e) => e.reason === "done");
  const out: TriageSection[] = [];
  if (blocked.length) out.push({ id: "blocked", label: "Blocked", entries: blocked });
  if (review.length) out.push({ id: "review", label: "To review", entries: review });
  return out;
}

export const REASON_LABEL: Record<NeedsReason, string> = {
  permission: "Needs approval",
  budget: "Limit reached",
  rate_limited: "Usage limit",
  error: "Error",
  done: "Done · unread",
};

/** A question is not an approval, so it reads "Needs you". */
export function reasonLabel(reason: NeedsReason, asksQuestion = false): string {
  return asksQuestion && reason === "permission" ? "Needs you" : REASON_LABEL[reason];
}

/** "3 agents need you", "1 agent needs you". */
export function needsYouLabel(count: number): string {
  return `${count} ${count === 1 ? "agent needs" : "agents need"} you`;
}

// ---------------------------------------------------------------------------
// Projects

/** Key of the group that holds archived agents (not a real project path). */
export const projectKey = (path: string | undefined) => (path ?? "").trim().replace(/[\\/]+$/, "");

export interface ProjectGroup {
  /** The project folder, without a trailing slash ("" when the server hides it). */
  path: string;
  name: string;
  /** Not archived: agents that need you first, then working ones, then the most recently active. */
  agents: Agent[];
  /** Agents that need the owner, by `needsReason`: the same count as the badge. */
  needs: number;
  working: number;
  lastActivityAt: number;
}

const isWorking = (a: Agent, background = false) => background || a.status === "working" || a.status === "starting";

/**
 * The agent list by project: every folder that has agents, projects that need you first and then the
 * most recently active. Archived agents come back separately. `query` filters like the desktop sidebar
 * (title, folder, branch, last message).
 */
export function groupByProject(
  agents: readonly Agent[],
  query = "",
  reasonOf: (a: Agent) => NeedsReason | null = (a) => needsReason(a),
  backgroundOf: (a: Agent) => boolean = () => false,
): { projects: ProjectGroup[]; archived: Agent[] } {
  const q = query.trim().toLowerCase();
  const match = (a: Agent) =>
    !q ||
    a.title.toLowerCase().includes(q) ||
    (a.projectPath ?? "").toLowerCase().includes(q) ||
    (a.branch ?? "").toLowerCase().includes(q) ||
    (a.lastMessage ?? "").toLowerCase().includes(q);

  const byPath = new Map<string, Agent[]>();
  const archived: Agent[] = [];
  for (const a of agents) {
    if (!match(a)) continue;
    if (a.archived) {
      archived.push(a);
      continue;
    }
    const key = projectKey(a.projectPath);
    const list = byPath.get(key);
    if (list) list.push(a);
    else byPath.set(key, [a]);
  }
  const byActivity = (x: Agent, y: Agent) => y.lastActivityAt - x.lastActivityAt;
  const rank = (a: Agent) => {
    const reason = reasonOf(a);
    return reason ? NEED_RANK[reason] : isWorking(a, backgroundOf(a)) ? 5 : 6;
  };
  const projects: ProjectGroup[] = [];
  for (const [path, list] of byPath) {
    list.sort((x, y) => rank(x) - rank(y) || byActivity(x, y));
    projects.push({
      path,
      name: path ? basename(path) : "Other",
      agents: list,
      needs: list.filter((a) => reasonOf(a) !== null).length,
      working: list.filter((a) => isWorking(a, backgroundOf(a))).length,
      lastActivityAt: Math.max(...list.map((a) => a.lastActivityAt)),
    });
  }
  projects.sort((x, y) => Number(y.needs > 0) - Number(x.needs > 0) || y.lastActivityAt - x.lastActivityAt || x.name.localeCompare(y.name));
  archived.sort(byActivity);
  return { projects, archived };
}

/** "3 agents · 2 working". */
export function projectSummary(p: Pick<ProjectGroup, "agents" | "working">): string {
  const n = p.agents.length;
  return `${n} ${n === 1 ? "agent" : "agents"}${p.working > 0 ? ` · ${p.working} working` : ""}`;
}
