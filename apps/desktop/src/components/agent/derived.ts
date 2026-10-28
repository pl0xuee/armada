// Structure-derived agent data (files touched, running sub-agents, latest plan) for the header and
// Inspector. Streaming replaces the items array on every frame, but these values only
// depend on tool calls' locations/diffs/kind/status/subagent. We keep a per-agent
// signature of those fields and reuse the cached result while it matches: no scans that
// allocate, no sorting, and stable references (so selectors don't re-render) per frame.
import { filesTouched, latestPlan, runningCount, subagentRuns, type SubagentRun } from "@/lib/agents";
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

/** `busy`: the agent is working (open sub-agent calls only count then); see `subagentRuns`. */
export function agentDerived(agentId: string, items: TimelineItem[] | undefined, busy = true): AgentDerived {
  if (!items || items.length === 0) return EMPTY;
  const e = cache.get(agentId);
  if (e) {
    if (e.list === items && e.busy === busy) return e.value;
    if (matches(items, e.sig)) {
      e.list = items;
      if (e.busy !== busy) {
        const subagents = subagentRuns(items, busy);
        e.busy = busy;
        e.value = { ...e.value, subagents, runningSubagents: runningCount(subagents) };
      }
      return e.value;
    }
  }
  const files = filesTouched(items);
  const subagents = subagentRuns(items, busy);
  const value: AgentDerived = {
    files,
    changedCount: files.filter((f) => f.edited).length,
    runningSubagents: runningCount(subagents),
    subagents,
    plan: latestPlan(items),
  };
  cache.set(agentId, { list: items, sig: signature(items), busy, value });
  return value;
}

/** Forget an agent's cache entry (e.g. when its items are evicted). */
export function forgetAgentDerived(agentId: string) {
  cache.delete(agentId);
}
