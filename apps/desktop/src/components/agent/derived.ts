// Structure-derived agent data (files touched, running sub-agents, latest plan) for the header and
// Inspector. Streaming replaces the items array on every frame, but these values only
// depend on tool calls' locations/diffs/kind/status/subagent. We keep a per-agent
// signature of those fields and reuse the cached result while it matches: no scans that
// allocate, no sorting, and stable references (so selectors don't re-render) per frame.
import {
  filesTouched,
  latestPlan,
  runningCount,
  SUBAGENT_TICK_MS,
  subagentRuns,
  type SubagentClock,
  type SubagentRun,
} from "@/lib/agents";
import type { TimelineItem } from "@/lib/types";

type Tool = Extract<TimelineItem, { kind: "tool_call" }>;

export interface AgentDerived {
  files: { path: string; edited: boolean; count: number }[];
  changedCount: number;
  runningSubagents: number;
  /** Running sub-agents plus the ones finished this turn. */
  subagents: SubagentRun[];
  plan: Extract<TimelineItem, { kind: "plan" }> | null;
}

interface Entry {
  list: TimelineItem[];
  /** In item order: tool calls as [TOOL, locations, diffs, toolKind, status, subagent, title, parent, toolCallId]; plans as [PLAN, item]; user messages as [USER]. */
  sig: unknown[];
  busy: boolean;
  live: boolean;
  /** floor(now / SUBAGENT_TICK_MS) the sub-agent runs were computed at. */
  bucket: number;
  /** Any background sub-agent: only then does the clock matter. */
  hasBg: boolean;
  value: AgentDerived;
}

const NO_RUNS: SubagentRun[] = [];
const EMPTY: AgentDerived = { files: [], changedCount: 0, runningSubagents: 0, subagents: NO_RUNS, plan: null };
const cache = new Map<string, Entry>();
const TOOL = 1;
const PLAN = 2;
const USER = 3;

function matches(items: TimelineItem[], sig: unknown[]): boolean {
  let j = 0;
  for (const it of items) {
    if (it.kind === "tool_call") {
      const t: Tool = it;
      if (
        sig[j] !== TOOL ||
        sig[j + 1] !== t.locations ||
        sig[j + 2] !== t.diffs ||
        sig[j + 3] !== t.toolKind ||
        sig[j + 4] !== t.status ||
        sig[j + 5] !== t.subagent ||
        sig[j + 6] !== t.title ||
        sig[j + 7] !== t.parentToolCallId ||
        sig[j + 8] !== t.toolCallId
      )
        return false;
      j += 9;
    } else if (it.kind === "plan") {
      if (sig[j] !== PLAN || sig[j + 1] !== it) return false;
      j += 2;
    } else if (it.kind === "user_message") {
      if (sig[j] !== USER) return false;
      j += 1;
    }
  }
  return j === sig.length;
}

function signature(items: TimelineItem[]): unknown[] {
  const sig: unknown[] = [];
  for (const it of items) {
    if (it.kind === "tool_call")
      sig.push(
        TOOL,
        it.locations,
        it.diffs,
        it.toolKind,
        it.status,
        it.subagent,
        it.title,
        it.parentToolCallId,
        it.toolCallId,
      );
    else if (it.kind === "plan") sig.push(PLAN, it);
    else if (it.kind === "user_message") sig.push(USER);
  }
  return sig;
}

const hasBackground = (items: TimelineItem[]) =>
  items.some((it) => it.kind === "tool_call" && it.subagent?.background && !it.subagent.control);

/**
 * `busy`: the agent is working (open sub-agent calls only count then); see `subagentRuns`.
 * `clock`: omit for structure-only data (files, plan); the sub-agent fields are then whatever was last computed with a clock. Time-based rules for background sub-agents. Results are cached on tool-call structure +
 * busy + liveness + a coarse time bucket, so streamed deltas never recompute them.
 */
export function agentDerived(
  agentId: string,
  items: TimelineItem[] | undefined,
  busy = true,
  clock?: SubagentClock,
): AgentDerived {
  if (!items || items.length === 0) return EMPTY;
  const live = clock?.live ?? true;
  const bucket = clock ? Math.floor(clock.now / SUBAGENT_TICK_MS) : 0;
  const e = cache.get(agentId);
  // Without a clock the caller wants structure data only (files, plan); leave the runs as cached.
  if (e && !clock && (e.list === items || matches(items, e.sig))) {
    e.list = items;
    return e.value;
  }
  if (e) {
    const timeStale = e.hasBg && e.bucket !== bucket;
    if (e.list === items && e.busy === busy && e.live === live && !timeStale) return e.value;
    if (matches(items, e.sig)) {
      e.list = items;
      if (e.busy !== busy || e.live !== live || timeStale) {
        const subagents = subagentRuns(items, busy, clock);
        e.busy = busy;
        e.live = live;
        e.bucket = bucket;
        const n = runningCount(subagents);
        // Keep references stable when a tick changed nothing.
        if (!sameRuns(e.value.subagents, subagents)) e.value = { ...e.value, subagents, runningSubagents: n };
      }
      return e.value;
    }
  }
  const files = filesTouched(items);
  const subagents = subagentRuns(items, busy, clock);
  const value: AgentDerived = {
    files,
    changedCount: files.filter((f) => f.edited).length,
    runningSubagents: runningCount(subagents),
    subagents,
    plan: latestPlan(items),
  };
  cache.set(agentId, { list: items, sig: signature(items), busy, live, bucket, hasBg: hasBackground(items), value });
  return value;
}

function sameRuns(a: SubagentRun[], b: SubagentRun[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (x, i) => x.itemId === b[i].itemId && x.state === b[i].state && x.step === b[i].step && x.calls === b[i].calls,
    )
  );
}

/** Forget an agent's cache entry (e.g. when its items are evicted). */
export function forgetAgentDerived(agentId: string) {
  cache.delete(agentId);
}
