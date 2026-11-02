// Claude "Workflow" runs: several agents working in parallel, started by one tool call that returns
// at launch. The backend reads the run's transcript folder (`workflow_progress`); this module turns
// that into what the UI shows and keeps it fresh: one poll per run, every 3 s, only while the window
// is focused and the run is not finished, shared by everything that watches it (dock row, card).
import { create } from "zustand";
import { api } from "./api";
import { pluralize } from "./format";
import type { TimelineItem, WorkflowAgent, WorkflowProgress } from "./types";

type ToolItem = Extract<TimelineItem, { kind: "tool_call" }>;

export const WORKFLOW_POLL_MS = 3000;
/** Workflow calls older than this are not watched (their run is long over). */
export const WORKFLOW_WATCH_MAX_AGE_MS = 12 * 3600_000;
/** The newest this many runs of an agent are watched. */
export const WORKFLOW_WATCH_MAX = 3;
/** How long the "Workflow finished" row stays before it folds away. */
export const WORKFLOW_LINGER_MS = 4000;
const MAX_FAILURES = 3;

export const isWorkflowCall = (it: TimelineItem): it is ToolItem => it.kind === "tool_call" && !!it.subagent?.workflow;

export interface WorkflowCall {
  itemId: string;
  toolCallId: string;
  /** When it was launched. */
  ts: number;
}

/** The agent's recent workflow runs, newest first. */
export function recentWorkflowCalls(items: TimelineItem[] | undefined, now: number): WorkflowCall[] {
  const calls: WorkflowCall[] = [];
  if (!items) return calls;
  for (let i = items.length - 1; i >= 0 && calls.length < WORKFLOW_WATCH_MAX; i--) {
    const it = items[i];
    if (isWorkflowCall(it) && now - it.ts < WORKFLOW_WATCH_MAX_AGE_MS)
      calls.push({ itemId: it.id, toolCallId: it.toolCallId, ts: it.ts });
  }
  return calls;
}

/**
 * The agent's recent workflow runs, newest first, encoded as one string (a primitive, so a selector
 * using it doesn't re-render per streamed token). Decode with `parseWorkflowKey`.
 */
export function recentWorkflowKey(items: TimelineItem[] | undefined, now: number): string {
  return recentWorkflowCalls(items, now)
    .map((c) => [c.itemId, c.toolCallId, c.ts].join("\t"))
    .join("\n");
}

export function parseWorkflowKey(key: string): WorkflowCall[] {
  return key
    ? key.split("\n").map((c) => {
        const [itemId, toolCallId, ts] = c.split("\t");
        return { itemId, toolCallId, ts: Number(ts) };
      })
    : [];
}

export const workflowKey = (agentId: string, toolCallId: string) => `${agentId}\u0000${toolCallId}`;

// ---- what a progress report means -------------------------------------------------------------

export interface WorkflowSummary {
  total: number;
  working: number;
  finished: number;
  failed: number;
  calls: number;
  /** The run is still going (an agent works, or it just started / is between phases). */
  active: boolean;
  /** One line for the dock: "Workflow · 5 agents working". */
  headline: string;
  /** The most recently active working agent's latest action. */
  step: string | null;
}

export function summarizeWorkflow(p: WorkflowProgress | null | undefined): WorkflowSummary {
  const agents = p?.agents ?? [];
  const working = agents.filter((a) => a.status === "working");
  const failed = agents.filter((a) => a.status === "failed").length;
  const finished = agents.filter((a) => a.status === "finished").length + failed;
  const calls = agents.reduce((n, a) => n + a.toolCalls, 0);
  const active = p?.state === "running";
  let headline: string;
  if (p?.state === "finished")
    headline = failed > 0 ? `Workflow finished · ${failed} of ${agents.length} failed` : "Workflow finished";
  else if (working.length > 0) headline = `Workflow · ${pluralize(working.length, "agent")} working`;
  else if (active) headline = agents.length > 0 ? "Workflow · wrapping up" : "Workflow · starting";
  else headline = "Workflow";
  const live = working.filter((a) => a.latest).sort((a, b) => (a.idleSecs ?? Infinity) - (b.idleSecs ?? Infinity))[0];
  return {
    total: agents.length,
    working: working.length,
    finished,
    failed,
    calls,
    active,
    headline,
    step: live?.latest ?? null,
  };
}

/** Working agents first (most recently active first), then the rest in their launch order. */
export function orderAgents(agents: readonly WorkflowAgent[]): WorkflowAgent[] {
  const rank = (a: WorkflowAgent) => (a.status === "working" ? 0 : a.status === "unknown" ? 1 : 2);
  return agents
    .map((a, i) => [a, i] as const)
    .sort(([a, i], [b, j]) => rank(a) - rank(b) || i - j)
    .map(([a]) => a);
}

// ---- store and poller -------------------------------------------------------------------------

export interface WorkflowEntry {
  progress: WorkflowProgress | null;
  /** Reading failed repeatedly (folder gone, not allowed); nothing more is asked. */
  failed: boolean;
}

export const useWorkflows = create<{ byKey: Record<string, WorkflowEntry> }>(() => ({ byKey: {} }));

interface Watch {
  agentId: string;
  toolCallId: string;
  count: number;
  timer: ReturnType<typeof setInterval> | null;
  inflight: boolean;
  failures: number;
  /** Consecutive reads that said neither running nor finished. */
  stale: number;
  done: boolean;
}

const watches = new Map<string, Watch>();
let listening = false;

const blurred = () => document.documentElement.dataset.window === "blurred" || document.hidden;

function put(key: string, entry: WorkflowEntry) {
  useWorkflows.setState((s) => ({ byKey: { ...s.byKey, [key]: entry } }));
}

async function poll(key: string, force = false) {
  const w = watches.get(key);
  if (!w || w.inflight || w.done || (!force && blurred())) return;
  w.inflight = true;
  try {
    const progress = await api.workflowProgress(w.agentId, w.toolCallId);
    w.failures = 0;
    w.stale = progress.state === "unknown" ? w.stale + 1 : 0;
    // Finished is final; a run that went quiet is given a few more reads in case it was a hiccup.
    if (progress.state === "finished" || w.stale >= MAX_FAILURES) stop(w);
    put(key, { progress, failed: false });
  } catch {
    w.failures += 1;
    if (w.failures >= MAX_FAILURES) {
      stop(w);
      put(key, { progress: useWorkflows.getState().byKey[key]?.progress ?? null, failed: true });
    }
  } finally {
    w.inflight = false;
  }
}

/** One read of a watched run even while the window is blurred (the caller decides that is worth it). */
export function pollWorkflowNow(agentId: string, toolCallId: string) {
  void poll(workflowKey(agentId, toolCallId), true);
}

/**
 * A fresh read of a run that was thought finished (finished is otherwise final, so nothing re-reads it):
 * used before announcing the end. A run that moves again is stored as running, so it is watched again.
 */
export async function recheckWorkflow(agentId: string, toolCallId: string): Promise<WorkflowProgress | null> {
  const key = workflowKey(agentId, toolCallId);
  try {
    const progress = await api.workflowProgress(agentId, toolCallId);
    if (progress.state !== "finished") watches.delete(key);
    put(key, { progress, failed: false });
    return progress;
  } catch {
    return null;
  }
}

function stop(w: Watch) {
  w.done = true;
  if (w.timer) clearInterval(w.timer);
  w.timer = null;
}

function onWake() {
  if (blurred()) return;
  for (const key of watches.keys()) void poll(key);
}

/**
 * Starts (or joins) the polling of one run; call the result to leave. The poll is immediate, then every
 * WORKFLOW_POLL_MS while the window is focused. A run that finished stays finished: re-joining does not ask again.
 */
export function watchWorkflow(agentId: string, toolCallId: string): () => void {
  const key = workflowKey(agentId, toolCallId);
  let w = watches.get(key);
  if (!w) {
    const known = useWorkflows.getState().byKey[key];
    w = {
      agentId,
      toolCallId,
      count: 0,
      timer: null,
      inflight: false,
      failures: 0,
      stale: 0,
      done: known?.progress?.state === "finished" || !!known?.failed,
    };
    watches.set(key, w);
    if (!w.done) {
      w.timer = setInterval(() => void poll(key), WORKFLOW_POLL_MS);
      void poll(key);
    }
  }
  w.count += 1;
  if (!listening) {
    listening = true;
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
  }
  return () => {
    const cur = watches.get(key);
    if (!cur) return;
    cur.count -= 1;
    if (cur.count > 0) return;
    stop(cur);
    watches.delete(key);
    if (watches.size === 0 && listening) {
      listening = false;
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    }
  };
}

/** Test hook: forget every watch and cached report. */
export function resetWorkflows() {
  for (const w of watches.values()) stop(w);
  watches.clear();
  useWorkflows.setState({ byKey: {} });
}
