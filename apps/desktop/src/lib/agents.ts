import type { Account, Agent, TimelineItem } from "./types";
import { basename } from "./utils";

/** Key of the group that holds archived agents (not a real project path). */
export const ARCHIVED_KEY = "__archived__";

export interface ProjectGroup {
  /** The project folder, without a trailing slash. */
  path: string;
  /** The folder's name. */
  name: string;
  /** Not archived: agents that need you first, then working ones, then the most recently active. */
  agents: Agent[];
  /** Agents waiting for the user (permission, error, interrupted). */
  needs: number;
  working: number;
  lastActivityAt: number;
}

const NEEDS_RANK: Partial<Record<Agent["status"], number>> = {
  needs_permission: 0,
  error: 1,
  interrupted: 2,
};

const needsYou = (a: Agent) => a.status in NEEDS_RANK || a.pendingPermissions > 0;
const isWorking = (a: Agent) => a.status === "working" || a.status === "starting";

export const projectKey = (path: string) => path.trim().replace(/[\\/]+$/, "") || path;

/**
 * The sidebar's projects: every folder that has agents, each with its agents, projects that
 * need you first and then the most recently active. Archived agents are returned separately.
 * `query` filters agents (title, folder, branch, last message).
 */
export function groupByProject(agents: Agent[], query = ""): { projects: ProjectGroup[]; archived: Agent[] } {
  const q = query.trim().toLowerCase();
  const match = (a: Agent) =>
    !q ||
    a.title.toLowerCase().includes(q) ||
    a.projectPath.toLowerCase().includes(q) ||
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
  const rank = (a: Agent) => (needsYou(a) ? (NEEDS_RANK[a.status] ?? 0) : isWorking(a) ? 3 : 4);
  const projects: ProjectGroup[] = [];
  for (const [path, list] of byPath) {
    list.sort((x, y) => rank(x) - rank(y) || byActivity(x, y));
    projects.push({
      path,
      name: basename(path),
      agents: list,
      needs: list.filter(needsYou).length,
      working: list.filter(isWorking).length,
      lastActivityAt: Math.max(...list.map((a) => a.lastActivityAt)),
    });
  }
  projects.sort(
    (x, y) =>
      Number(y.needs > 0) - Number(x.needs > 0) || y.lastActivityAt - x.lastActivityAt || x.name.localeCompare(y.name),
  );
  archived.sort(byActivity);
  return { projects, archived };
}

/** Flat order used by ⌘1..9: the sidebar's order, project by project (archived excluded). */
export function orderedAgents(agents: Agent[]): Agent[] {
  return groupByProject(agents).projects.flatMap((p) => p.agents);
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
    if (it.kind === "question" && it.resolution === null) return `Asking: ${it.message}`;
  }
  return null;
}

export function isBusy(a: Agent) {
  return a.status === "working" || a.status === "starting" || a.status === "needs_permission";
}

type ToolItem = Extract<TimelineItem, { kind: "tool_call" }>;

/** One line describing what a running agent is doing right now (current tool, or its latest thought). */
export function liveTail(items: TimelineItem[] | undefined): string | null {
  if (!items) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user_message") return null;
    if (it.kind === "tool_call" && (it.status === "in_progress" || it.status === "pending")) {
      // Prefer the newest child of a running sub-agent.
      return it.subagent?.description ? `${it.subagent.kind ?? "Sub-agent"}: ${it.subagent.description}` : it.title;
    }
    if (it.kind === "permission" && it.resolution === null) return `Waiting for approval: ${it.title}`;
    if (it.kind === "question" && it.resolution === null) return `Waiting for your answer: ${it.message}`;
    if (it.kind === "thought" && it.text.trim()) {
      const t = it.text
        .replace(/[*_`#>]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      return `Thinking: ${t.slice(0, 120)}`;
    }
    if (it.kind === "agent_message" && it.text.trim()) return "Writing a reply…";
  }
  return null;
}

/** One sub-agent of an agent, as shown in the running-sub-agents list. */
export interface SubagentRun {
  /** Timeline item id (for scrolling to its card). */
  itemId: string;
  toolCallId: string;
  kind: string | null;
  description: string;
  /** When it was launched. */
  startedAt: number;
  state: "running" | "done" | "failed";
  /** Title of its latest child call, if any. */
  step: string | null;
  background: boolean;
  /** The model / reasoning effort the launch named (null: it inherits the agent's). */
  model: string | null;
  effort: string | null;
  /** Tool calls it has made so far. */
  calls: number;
}

const unfinished = (s: ToolItem["status"]) => s === "in_progress" || s === "pending";

/** A background sub-agent counts as running while a child call is unfinished or active this recently. */
export const SUBAGENT_ACTIVE_WINDOW_MS = 90_000;
/** A just-launched background sub-agent counts as running this long, to produce its first child call. */
export const SUBAGENT_LAUNCH_GRACE_MS = 60_000;
/** An unfinished child call older than this is stale (idle agent), not a sign of life. */
const SUBAGENT_STALE_CHILD_MS = 30 * 60_000;
/** Resolution of the shared sub-agent clock; derived data is cached per bucket. */
export const SUBAGENT_TICK_MS = 5_000;

/** The wall clock and liveness an agent's background sub-agents are judged by. */
export interface SubagentClock {
  now: number;
  /** The agent can still be waiting on them: not stopped, errored or interrupted. */
  live: boolean;
}

/** Whether an agent's status allows background sub-agents to still be running. */
export function isSubagentLive(status: Agent["status"]): boolean {
  return status !== "stopped" && status !== "error" && status !== "interrupted";
}

/**
 * Sub-agents that are running, plus those that finished during the current turn (newest last).
 * `busy`: the agent is working. A sub-agent whose call is still open only counts while the agent
 * is busy (an idle agent's leftover open call is stale).
 *
 * A background sub-agent's call completes at launch, yet it keeps running and Claude's adapter
 * gives no finish signal; its results arrive as new automatic turns, with idle gaps between. With
 * a `clock` it counts as running when the agent is live and ANY of: (a) busy and the call is after
 * the last user message; (b) a child call is unfinished or the latest child activity is within
 * SUBAGENT_ACTIVE_WINDOW_MS; (c) it launched within SUBAGENT_LAUNCH_GRACE_MS. Without a clock only (a) applies.
 */
export function subagentRuns(items: TimelineItem[] | undefined, busy: boolean, clock?: SubagentClock): SubagentRun[] {
  if (!items) return [];
  let turnStartIdx = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === "user_message") {
      turnStartIdx = i;
      break;
    }
  }
  const lastChild = new Map<string, ToolItem>();
  const lastChildTs = new Map<string, number>();
  const callCount = new Map<string, number>();
  const openChildTs = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "tool_call" && it.parentToolCallId) {
      lastChild.set(it.parentToolCallId, it);
      callCount.set(it.parentToolCallId, (callCount.get(it.parentToolCallId) ?? 0) + 1);
      lastChildTs.set(it.parentToolCallId, Math.max(it.ts, lastChildTs.get(it.parentToolCallId) ?? 0));
      if (unfinished(it.status))
        openChildTs.set(it.parentToolCallId, Math.max(it.ts, openChildTs.get(it.parentToolCallId) ?? 0));
    }
  }
  const runs: SubagentRun[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind !== "tool_call" || !it.subagent || it.subagent.control) continue;
    const bg = !!it.subagent.background;
    const open = unfinished(it.status) || (bg && it.status === "completed" && i > turnStartIdx);
    let running = open && busy;
    if (bg && clock && it.status === "completed") {
      const lastTs = lastChildTs.get(it.toolCallId);
      const openTs = openChildTs.get(it.toolCallId);
      running =
        clock.live &&
        (running ||
          (openTs !== undefined && (busy || clock.now - openTs < SUBAGENT_STALE_CHILD_MS)) ||
          (lastTs !== undefined && clock.now - lastTs < SUBAGENT_ACTIVE_WINDOW_MS) ||
          clock.now - it.ts < SUBAGENT_LAUNCH_GRACE_MS);
    }
    if (!running && i <= turnStartIdx) continue;
    if (!running && unfinished(it.status)) continue; // stale: open call of an idle agent
    const child = lastChild.get(it.toolCallId);
    const description = it.subagent.description?.trim() || it.title;
    runs.push({
      itemId: it.id,
      toolCallId: it.toolCallId,
      kind: it.subagent.kind?.trim() || null,
      description,
      startedAt: it.ts,
      state: running ? "running" : it.status === "failed" ? "failed" : "done",
      step: child ? child.title : null,
      background: bg,
      model: it.subagent.model?.trim() || null,
      effort: it.subagent.effort?.trim() || null,
      calls: callCount.get(it.toolCallId) ?? 0,
    });
  }
  return runs;
}

/** Number of running sub-agents in `runs`. */
export function runningCount(runs: readonly SubagentRun[]): number {
  let n = 0;
  for (const r of runs) if (r.state === "running") n++;
  return n;
}

/** Child calls per sub-agent toolCallId. */
export function childrenByParent(items: TimelineItem[]): Map<string, ToolItem[]> {
  const m = new Map<string, ToolItem[]>();
  for (const it of items) {
    if (it.kind === "tool_call" && it.parentToolCallId) {
      const list = m.get(it.parentToolCallId) ?? [];
      list.push(it);
      m.set(it.parentToolCallId, list);
    }
  }
  return m;
}

/** Files changed so far (edits/diffs), for the header "Review diff" pill. */
export function changedFiles(items: TimelineItem[] | undefined): string[] {
  return items
    ? filesTouched(items)
        .filter((f) => f.edited)
        .map((f) => f.path)
    : [];
}

export type NeedsReason = "permission" | "error" | "rate_limited" | "done";

/** Why an agent needs the user, in triage priority order (null if it doesn't). */
export function needsAttention(a: Agent): NeedsReason | null {
  if (a.archived) return null;
  // An approval is still blocking, even if acknowledged.
  if (a.pendingPermissions > 0 || a.status === "needs_permission") return "permission";
  // "Done" in triage dismisses until the agent does something new.
  if (a.acknowledgedAt !== null && a.acknowledgedAt >= a.lastActivityAt) return null;
  if (a.rateLimited) return "rate_limited";
  if (a.status === "error") return "error";
  if (a.unread && (a.status === "idle" || a.status === "stopped" || a.status === "interrupted")) return "done";
  return null;
}

const NEED_RANK: Record<NeedsReason, number> = { permission: 0, rate_limited: 1, error: 2, done: 3 };

/** Agents that need the user, most urgent first, then oldest activity first (FIFO within a reason). */
export function triageQueue(agents: Agent[]): { agent: Agent; reason: NeedsReason }[] {
  return agents
    .map((agent) => ({ agent, reason: needsAttention(agent) }))
    .filter((x): x is { agent: Agent; reason: NeedsReason } => x.reason !== null)
    .sort((a, b) => NEED_RANK[a.reason] - NEED_RANK[b.reason] || a.agent.lastActivityAt - b.agent.lastActivityAt);
}
