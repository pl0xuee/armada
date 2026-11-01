/**
 * What the pinned dock above the composer shows (pure logic; the components are in `components/dock`).
 *
 * Same stack as the desktop's dock, shaped for a phone: the thing the agent waits on (approval, plan
 * approval, question), why it is blocked (usage limit, error, interrupted), then one row of small chips
 * (plan progress, sub-agents) that open sheets, then the queue.
 */
import { isPlanApproval } from "@shared/planApproval";
import { isChoice, otherOf, primaryFields } from "./question";
import type { Agent, PendingItem, PlanEntry, QuestionAnswers, QuestionField, QuestionItem, TimelineItem } from "./types";

// ---------------------------------------------------------------------------
// What the agent waits on

export type NeedKind = "permission" | "plan" | "question";

export interface DockNeed {
  kind: NeedKind;
  item: PendingItem;
  /** Other requests still open behind this one. */
  more: number;
}

/**
 * Same pick as the desktop's `latestNeedsYou`: the newest open approval (a plan approval is one), else the
 * newest open question (an approval acts first); the rest are a "+N" count.
 */
export function dockNeed(pending: readonly PendingItem[] | undefined): DockNeed | null {
  const open = (pending ?? []).filter((p) => p.resolution === null);
  if (!open.length) return null;
  const newest = (list: PendingItem[]) => list.reduce((a, b) => (b.ts >= a.ts ? b : a));
  const approvals = open.filter((p) => p.kind === "permission");
  const item = approvals.length ? newest(approvals) : newest(open);
  const kind: NeedKind = item.kind === "question" ? "question" : isPlanApproval(item) ? "plan" : "permission";
  return { kind, item, more: open.length - 1 };
}

export interface QuickChoice {
  value: string;
  label: string;
  description: string | null;
}

/** A question the dock can answer with one or two taps; anything else opens the full form in a sheet. */
export interface QuickQuestion {
  field: QuestionField;
  /** `single`/`boolean`: a tap answers. `multi`: tap to toggle, then Send. */
  mode: "single" | "multi" | "boolean";
  choices: QuickChoice[];
  /** The question also offers a free-text "Other": that goes through the full form. */
  hasOther: boolean;
}

/** Same limits as the desktop dock (QUICK_SINGLE_MAX / QUICK_MULTI_MAX). */
const MAX_SINGLE = 4;
const MAX_MULTI = 6;

export function quickQuestion(item: Pick<QuestionItem, "fields">): QuickQuestion | null {
  const fields = primaryFields(item.fields);
  if (fields.length !== 1) return null;
  const field = fields[0];
  if (field.secret) return null;
  const hasOther = isChoice(field) && otherOf(item.fields, field.id) !== null;
  if (field.kind === "boolean") {
    return {
      field,
      mode: "boolean",
      choices: [
        { value: "true", label: "Yes", description: null },
        { value: "false", label: "No", description: null },
      ],
      hasOther: false,
    };
  }
  const options = field.options ?? [];
  const choices = options.map((o) => ({ value: o.value, label: o.label, description: o.description?.trim() || null }));
  if (field.kind === "single" && choices.length >= 1 && choices.length <= MAX_SINGLE) return { field, mode: "single", choices, hasOther };
  if (field.kind === "multi" && choices.length >= 1 && choices.length <= MAX_MULTI) return { field, mode: "multi", choices, hasOther };
  return null;
}

/** The answers body for a quick question: `picked` are option values (booleans arrive as "true"/"false"). */
export function quickAnswers(q: QuickQuestion, picked: readonly string[]): QuestionAnswers {
  if (q.mode === "boolean") return { [q.field.id]: picked[0] === "true" };
  if (q.mode === "single") return { [q.field.id]: picked[0] };
  // Keep the options' order, whatever order they were tapped in.
  return { [q.field.id]: q.choices.map((c) => c.value).filter((v) => picked.includes(v)) };
}

/** The question's own words for the card: its message, else the lone field's title or description. */
export function questionHeadline(item: Pick<QuestionItem, "message" | "fields">): string {
  const fields = primaryFields(item.fields);
  const lone = fields.length === 1 ? fields[0].description?.trim() || fields[0].title?.trim() : null;
  return item.message?.trim() || lone || "Your agent has a question";
}

// ---------------------------------------------------------------------------
// Why it is blocked

export type BlockKind = "usage_limit" | "error" | "interrupted" | "stopped" | "conflict";

export interface DockBlock {
  kind: BlockKind;
  title: string;
}

/**
 * What stops the agent (besides a request waiting on you), if anything. A usage limit outranks a plain
 * error; an interrupted or stopped agent is resumable.
 */
export function dockBlock(agent: Pick<Agent, "status" | "rateLimited" | "helperSync" | "parentId">): DockBlock | null {
  const resumable = agent.status === "interrupted" || agent.status === "stopped";
  // The desktop's `blockers`: a usage limit unless the agent is shut down; an error that isn't a limit.
  if (agent.rateLimited === true && !resumable) return { kind: "usage_limit", title: "This account hit its usage limit" };
  if (agent.status === "error") return { kind: "error", title: "The last turn failed" };
  if (agent.status === "interrupted") return { kind: "interrupted", title: "Interrupted when Kvistcode closed" };
  if (agent.status === "stopped") return { kind: "stopped", title: "This agent was stopped" };
  if (agent.parentId && agent.helperSync?.state === "conflict") return { kind: "conflict", title: "Merge conflict with the main agent" };
  return null;
}

// ---------------------------------------------------------------------------
// Plan progress

type PlanItem = Extract<TimelineItem, { kind: "plan" }>;

export interface PlanProgress {
  done: number;
  total: number;
  /** The step being worked on (else the next one that isn't done). */
  current: string | null;
  complete: boolean;
  entries: PlanEntry[];
}

/** The newest plan in the conversation (the agent rewrites it as it goes). */
export function latestPlan(items: readonly TimelineItem[] | undefined): PlanItem | undefined {
  if (!items) return undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "plan") return it;
  }
  return undefined;
}

export function planProgress(plan: Pick<PlanItem, "entries"> | undefined): PlanProgress | null {
  const entries = plan?.entries ?? [];
  if (!entries.length) return null;
  const done = entries.filter((e) => e.status === "completed").length;
  const active = entries.find((e) => e.status === "in_progress") ?? entries.find((e) => e.status !== "completed");
  return { done, total: entries.length, current: active?.content?.trim() || null, complete: done === entries.length, entries };
}

/** A finished plan stays this long before the chip folds away (the desktop's PLAN_LINGER_MS). */
export const PLAN_LINGER_MS = 4_000;

export type PlanPhase = "active" | "done";

/**
 * Whether and how the plan chip shows (the desktop's `planPhase`). `live`: the plan belongs to the current
 * turn; `busy`: the agent is working. An unfinished plan shows only while it is live and the agent works (an
 * abandoned one is history); a finished one only while it `lingering`.
 */
export function planPhase(p: PlanProgress | null, state: { live: boolean; busy: boolean; lingering: boolean }): PlanPhase | null {
  if (!p || p.total === 0) return null;
  if (p.complete) return state.lingering ? "done" : null;
  return state.live && state.busy ? "active" : null;
}

/** The linger starts when an active plan stops being active because every step is done. */
export function lingerStarts(wasActive: boolean, phase: PlanPhase | null, p: PlanProgress | null): boolean {
  return wasActive && phase !== "active" && Boolean(p?.complete);
}

/** The latest plan belongs to the current turn: it comes after the last real user message (one typed mid-turn doesn't start a turn). */
export function planIsLive(items: readonly TimelineItem[] | undefined): boolean {
  let planAt = -1;
  let userAt = -1;
  (items ?? []).forEach((it, i) => {
    if (it.kind === "plan") planAt = i;
    else if (it.kind === "user_message" && !it.midTurn) userAt = i;
  });
  return planAt >= 0 && planAt > userAt;
}

// ---------------------------------------------------------------------------
// Sub-agents chip

/** "2 sub-agents" / the one's task, and the step to show beside it. */
export function subagentHeadline(running: readonly { description: string }[]): string {
  if (running.length === 1) return running[0].description;
  return `${running.length} sub-agents`;
}

// ---------------------------------------------------------------------------
// Usage limit

const RESET = /\bresets?\s+(?:(at|in|on|around|after)\s+)?([^.;\n]{1,40})/i;

/** The "resets at 6:00 PM" part of a provider's usage-limit message ("Resets at 6:00 PM"); null when it names none. */
export function resetClause(text: string | null | undefined): string | null {
  const m = text ? RESET.exec(text) : null;
  if (!m) return null;
  const rest = m[2].trim().replace(/[)\s]+$/, "");
  if (!rest) return null;
  return m[1] ? `Resets ${m[1].toLowerCase()} ${rest}` : `Resets ${rest}`;
}

/** The message without its reset clause (the dock shows that one separately). */
export function withoutReset(text: string): string {
  return text
    .replace(new RegExp(`\\s*(?:\\bit\\s+)?${RESET.source}\\.?`, "i"), "")
    .replace(/\s+/g, " ")
    .trim();
}
