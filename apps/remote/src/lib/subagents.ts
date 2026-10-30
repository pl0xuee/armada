/**
 * Which sub-agents are still running. The phone's copy of the desktop's `subagentRuns`
 * (`lib/agents.ts`): a background sub-agent's call completes at launch yet it keeps running
 * (its results arrive as new turns), so "running" is judged from the agent's state and the clock.
 * Sub-agent management calls (`subagent.control`: Codex wait/close/send) are never counted.
 */
import { useEffect, useMemo, useState } from "react";
import { choiceName } from "./config";
import { isBusy } from "./meta";
import { isLauncher } from "./rows";
import { useStore } from "./store";
import type { Agent, ConfigOption, SubagentInfo, TimelineItem, ToolCallItem } from "./types";

export interface SubagentRun {
  itemId: string;
  toolCallId: string;
  state: "running" | "done" | "failed";
  background: boolean;
}

export interface SubagentClock {
  now: number;
  /** The agent can still be waiting on them: not stopped, errored or interrupted. */
  live: boolean;
}

const unfinished = (s: ToolCallItem["status"]) => s === "in_progress" || s === "pending";

/** A background sub-agent counts as running while a child call is unfinished or active this recently. */
export const SUBAGENT_ACTIVE_WINDOW_MS = 90_000;
/** A just-launched background sub-agent counts as running this long, to produce its first child call. */
export const SUBAGENT_LAUNCH_GRACE_MS = 60_000;
/** An unfinished child call older than this is stale (idle agent), not a sign of life. */
const SUBAGENT_STALE_CHILD_MS = 30 * 60_000;
/** Resolution of the sub-agent clock. */
export const SUBAGENT_TICK_MS = 5_000;
/** How long "waiting on sub-agents" outlives the last counted running one (brief idle gaps between turns). */
export const WAITING_HOLD_MS = 6_000;

/** Whether an agent's status allows background sub-agents to still be running. */
export function isSubagentLive(status: Agent["status"]): boolean {
  return status !== "stopped" && status !== "error" && status !== "interrupted";
}

export function hasBackgroundSubagent(items: TimelineItem[] | undefined): boolean {
  return !!items && items.some((it) => isLauncher(it) && !!it.subagent?.background);
}

/**
 * When the last time-based rule of `subagentRuns` stops applying to any background sub-agent: past
 * this instant a clock tick can no longer change the result (0: no background sub-agent to watch).
 * It is the latest of each launch grace, each last child activity window, and the stale limit of a
 * still-open child call.
 */
export function clockExpiry(items: TimelineItem[] | undefined): number {
  if (!items || !hasBackgroundSubagent(items)) return 0;
  const lastChildTs = new Map<string, number>();
  const openChildTs = new Map<string, number>();
  for (const it of items) {
    if (it.kind === "tool_call" && it.parentToolCallId) {
      lastChildTs.set(it.parentToolCallId, Math.max(it.ts, lastChildTs.get(it.parentToolCallId) ?? 0));
      if (unfinished(it.status)) openChildTs.set(it.parentToolCallId, Math.max(it.ts, openChildTs.get(it.parentToolCallId) ?? 0));
    }
  }
  let expiry = 0;
  for (const it of items) {
    if (!isLauncher(it) || !it.subagent?.background || it.status !== "completed") continue;
    const last = lastChildTs.get(it.toolCallId);
    const open = openChildTs.get(it.toolCallId);
    expiry = Math.max(
      expiry,
      it.ts + SUBAGENT_LAUNCH_GRACE_MS,
      last === undefined ? 0 : last + SUBAGENT_ACTIVE_WINDOW_MS,
      open === undefined ? 0 : open + SUBAGENT_STALE_CHILD_MS,
    );
  }
  return expiry;
}

/**
 * Sub-agents that are running, plus those that finished during the current turn. `busy`: the
 * agent is working; a sub-agent whose call is still open only counts while it is (an idle agent's
 * leftover open call is stale). A background sub-agent counts as running when the agent is live
 * and ANY of: (a) busy and the call is after the last user message; (b) a child call is
 * unfinished or the latest child activity is within SUBAGENT_ACTIVE_WINDOW_MS; (c) it launched
 * within SUBAGENT_LAUNCH_GRACE_MS. Without a `clock` only (a) applies.
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
  const lastChildTs = new Map<string, number>();
  const openChildTs = new Map<string, number>();
  for (const it of items) {
    if (it.kind === "tool_call" && it.parentToolCallId) {
      lastChildTs.set(it.parentToolCallId, Math.max(it.ts, lastChildTs.get(it.parentToolCallId) ?? 0));
      if (unfinished(it.status)) openChildTs.set(it.parentToolCallId, Math.max(it.ts, openChildTs.get(it.parentToolCallId) ?? 0));
    }
  }
  const runs: SubagentRun[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!isLauncher(it)) continue;
    const bg = !!it.subagent?.background;
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
    runs.push({ itemId: it.id, toolCallId: it.toolCallId, state: running ? "running" : it.status === "failed" ? "failed" : "done", background: bg });
  }
  return runs;
}

export const runningCount = (runs: readonly SubagentRun[]) => runs.reduce((n, r) => n + (r.state === "running" ? 1 : 0), 0);

const bucket = () => Math.floor(Date.now() / SUBAGENT_TICK_MS) * SUBAGENT_TICK_MS;

/**
 * A clock that ticks every SUBAGENT_TICK_MS while `live` and a time-based rule can still change
 * something (`expiry`, from clockExpiry): an idle agent with an old background launcher in its
 * history doesn't wake the timeline up forever.
 */
function useSubagentNow(live: boolean, expiry: number): number {
  const [now, setNow] = useState(bucket);
  const enabled = live && expiry > now;
  useEffect(() => {
    if (!enabled) return;
    setNow(bucket());
    const id = setInterval(() => setNow(bucket()), SUBAGENT_TICK_MS);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

const NO_IDS: ReadonlySet<string> = new Set();

export interface SubagentState {
  /** Running sub-agents (not counting control calls). */
  running: number;
  /** The sub-agents of this turn, running or finished (see `runningSubagents`). */
  runs: SubagentRun[];
  /** toolCallIds of background sub-agents counted as running (their launch call already completed). */
  bgRunning: ReadonlySet<string>;
}

/** Sub-agent state for the open conversation; `bgRunning` keeps its identity while its contents don't change. */
export function useSubagentState(agent: Pick<Agent, "status">, items: TimelineItem[]): SubagentState {
  const busy = isBusy(agent.status);
  const live = isSubagentLive(agent.status);
  const expiry = useMemo(() => clockExpiry(items), [items]);
  const now = useSubagentNow(live, expiry);
  const runs = useMemo(() => subagentRuns(items, busy, { now, live }), [items, busy, now, live]);
  const key = runs.filter((r) => r.state === "running" && r.background).map((r) => r.toolCallId).join(",");
  const bgRunning = useMemo(() => (key ? new Set(key.split(",")) : NO_IDS), [key]);
  return { running: runningCount(runs), runs, bgRunning };
}

/** A running sub-agent, as the live status line lists it. */
export interface RunningSubagent {
  id: string;
  kind: string;
  description: string;
  /** What the launch asked for; absent fields inherit the main agent's. */
  model: string | null;
  effort: string | null;
  /** When it was launched (ms). */
  startedAt: number;
  /** Tool calls it has made so far, counting those of sub-agents it started itself. */
  toolCalls: number;
}

/** The running sub-agents among `runs`, in launch order. */
export function runningSubagents(items: readonly TimelineItem[], runs: readonly SubagentRun[]): RunningSubagent[] {
  const running = new Set(runs.filter((r) => r.state === "running").map((r) => r.itemId));
  if (!running.size) return [];
  const byParent = new Map<string, ToolCallItem[]>();
  for (const it of items) {
    if (it.kind === "tool_call" && it.parentToolCallId) {
      const l = byParent.get(it.parentToolCallId);
      if (l) l.push(it);
      else byParent.set(it.parentToolCallId, [it]);
    }
  }
  const count = (toolCallId: string, seen: Set<string>): number => {
    if (seen.has(toolCallId)) return 0;
    seen.add(toolCallId);
    let n = 0;
    for (const c of byParent.get(toolCallId) ?? []) n += 1 + (c.subagent && !c.subagent.control ? count(c.toolCallId, seen) : 0);
    return n;
  };
  const out: RunningSubagent[] = [];
  for (const it of items) {
    if (it.kind !== "tool_call" || !running.has(it.id)) continue;
    const s = it.subagent;
    out.push({
      id: it.id,
      kind: s?.kind?.trim() || "Sub-agent",
      description: s?.description?.trim() || it.title,
      model: s?.model?.trim() || null,
      effort: s?.effort?.trim() || null,
      startedAt: it.ts,
      toolCalls: count(it.toolCallId, new Set()),
    });
  }
  return out;
}

/** The main agent's current model and effort: what a sub-agent that names none runs on. */
export interface InheritedConfig {
  model: string | null;
  effort: string | null;
}

export function inheritedConfig(agent: Pick<Agent, "configOptions" | "model">): InheritedConfig {
  const opts = agent.configOptions ?? [];
  const pick = (o: ConfigOption | undefined) => (o?.currentValue ? choiceName(o) : null);
  const model = pick(opts.find((o) => o.category === "model"));
  return { model: model ?? agent.model ?? null, effort: pick(opts.find((o) => o.category === "thought_level")) };
}

export interface SubagentChip {
  key: "model" | "effort";
  text: string;
  /** Not named by the launch: the main agent's value. */
  inherited: boolean;
}

/**
 * Model and effort chips for a sub-agent. A value the launch didn't name shows as "inherits" with the
 * main agent's, or not at all when that isn't known (nothing is invented).
 */
export function subagentChips(info: Pick<SubagentInfo, "model" | "effort"> | undefined, inherited?: InheritedConfig): SubagentChip[] {
  const out: SubagentChip[] = [];
  const model = info?.model?.trim();
  if (model) out.push({ key: "model", text: model, inherited: false });
  else if (inherited?.model) out.push({ key: "model", text: `inherits ${inherited.model}`, inherited: true });
  const effort = info?.effort?.trim();
  if (effort) out.push({ key: "effort", text: `${effort} effort`, inherited: false });
  else if (inherited?.effort) out.push({ key: "effort", text: `inherits ${inherited.effort} effort`, inherited: true });
  return out;
}

/** Running sub-agent count for the header chip (a number, so streamed text doesn't re-render it). */
export function useRunningSubagentCount(agentId: string): number {
  const expiry = useStore((s) => clockExpiry(s.timelines[agentId]?.items));
  const live = useStore((s) => (s.agents[agentId] ? isSubagentLive(s.agents[agentId].status) : false));
  const now = useSubagentNow(live, expiry);
  return useStore((s) => {
    const agent = s.agents[agentId];
    const items = s.timelines[agentId]?.items;
    if (!agent || !items) return 0;
    return runningCount(subagentRuns(items, isBusy(agent.status), { now, live: isSubagentLive(agent.status) }));
  });
}

/** `value`, but a drop back to `empty` only takes effect after it stayed that way for `ms`. */
export function useHeld<T>(value: T, empty: T, ms: number): T {
  const [held, setHeld] = useState(value);
  const isEmpty = value === empty;
  useEffect(() => {
    if (!isEmpty) {
      setHeld(value);
      return;
    }
    const t = setTimeout(() => setHeld(empty), ms);
    return () => clearTimeout(t);
  }, [value, empty, isEmpty, ms]);
  return isEmpty ? held : value;
}
