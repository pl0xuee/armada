import type { AgentStatus, ConfigOption, TimelineItem } from "@/lib/types";
import { pluralize } from "@/lib/format";

/** Friendly status verbs the indicator cycles through while the agent is busy. */
export const THINKING_VERBS = [
  "Thinking",
  "Pondering",
  "Working on it",
  "Reading the code",
  "Connecting the dots",
  "Mulling it over",
  "Figuring it out",
  "Planning next steps",
] as const;

/**
 * Whether to show the live status line below the conversation: the one place that says what a busy
 * agent is doing right now. Always while it works, except when an approval or question is the call to
 * action (the card says it).
 */
export function shouldShowThinking(status: AgentStatus, last: TimelineItem | undefined): boolean {
  if (status !== "working" && status !== "starting") return false;
  if (!last) return true;
  if (last.kind === "permission" || last.kind === "question") return last.resolution !== null;
  return true;
}

/** What the agent is doing right now, in plain words. `detail` follows `lead` (mono for a command). */
export interface LiveStep {
  lead: string;
  detail: string | null;
  mono: boolean;
}

export const stepText = (s: LiveStep): string => (s.detail ? `${s.lead} ${s.detail}` : s.lead);

const unfinished = (it: TimelineItem): boolean =>
  it.kind === "tool_call" && (it.status === "pending" || it.status === "in_progress");

/** Tool titles read "Read src/a.ts", "Run npm test", "Search for `x`": drop the verb, quotes and backticks. */
function stripVerb(title: string, verbs: RegExp): string {
  return title.replace(verbs, "").replace(/[`"']/g, "").trim();
}

/** Long paths keep their last two segments. */
function shortPath(p: string): string {
  if (p.length <= 48) return p;
  const parts = p.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
}

type ToolItem = Extract<TimelineItem, { kind: "tool_call" }>;

function stepOf(calls: ToolItem[]): LiveStep {
  const c = calls[calls.length - 1];
  const n = calls.length;
  const plain = (lead: string, detail: string | null = null): LiveStep => ({ lead, detail, mono: false });
  switch (c.toolKind) {
    case "execute": {
      if (n > 1) return plain(`Running ${pluralize(n, "command")}`);
      const cmd = (c.command?.trim().split("\n")[0] ?? "") || stripVerb(c.title, /^(run(ning)?|bash|execute)\s+/i);
      return cmd ? { lead: "Running", detail: cmd, mono: true } : plain("Running a command");
    }
    case "read":
    case "edit":
    case "delete":
    case "move": {
      const [ing, noun] =
        c.toolKind === "read"
          ? ["Reading", "file"]
          : c.toolKind === "edit"
            ? ["Editing", "file"]
            : c.toolKind === "delete"
              ? ["Deleting", "file"]
              : ["Moving", "file"];
      if (n > 1) return plain(`${ing} ${pluralize(n, noun)}`);
      const path = c.locations[0] ?? stripVerb(c.title, /^(read(ing)?|edit(ing)?|create|write|delete|move)\s+/i);
      return path ? plain(ing, shortPath(path)) : plain(`${ing} a file`);
    }
    case "search": {
      if (n > 1) return plain(`Running ${pluralize(n, "search", "searches")}`);
      const q = stripVerb(c.title, /^search(ing)?( for)?\s*/i);
      return q ? plain("Searching for", `"${q}"`) : plain("Searching");
    }
    case "fetch": {
      if (n > 1) return plain(`Fetching ${pluralize(n, "page")}`);
      const url = stripVerb(c.title, /^fetch(ing)?\s*/i);
      return url ? plain("Fetching", url) : plain("Fetching a page");
    }
    case "think":
      return plain("Thinking…");
    default:
      return plain(c.title.trim() || "Working…");
  }
}

/**
 * The current step from the newest unfinished item at the end of the timeline, or null when nothing
 * names one (the line then cycles friendly verbs). Sub-agents and their calls are not steps: the line
 * says "Waiting on N sub-agents" for those. `messageSettled`: the last agent message stopped growing.
 */
export function liveStep(items: readonly TimelineItem[], messageSettled = false): LiveStep | null {
  let i = items.length - 1;
  const skip = (it: TimelineItem) => it.kind === "tool_call" && (!!it.parentToolCallId || !!it.subagent);
  while (i >= 0 && skip(items[i])) i--;
  const last = items[i];
  if (!last) return null;
  if (last.kind === "thought") return { lead: "Thinking…", detail: null, mono: false };
  if (last.kind === "agent_message") {
    return messageSettled ? null : { lead: "Writing…", detail: null, mono: false };
  }
  if (last.kind !== "tool_call") return null;
  // The trailing run of tool calls (parallel calls overlap): its unfinished ones, newest kind first.
  const open: ToolItem[] = [];
  for (let j = i; j >= 0; j--) {
    const it = items[j];
    if (skip(it)) continue;
    if (it.kind !== "tool_call") break;
    if (unfinished(it)) open.unshift(it);
  }
  if (open.length === 0) return null;
  const kind = open[open.length - 1].toolKind;
  return stepOf(open.filter((c) => c.toolKind === kind));
}

/** Start of the current turn: the latest user message, else `fallback`. */
export function turnStart(items: readonly TimelineItem[], fallback: number): number {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === "user_message") return items[i].ts;
  return fallback;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Indicator label while the agent waits on running sub-agents instead of cycling verbs. */
export function waitingLabel(subagents: number): string {
  return `Waiting on ${subagents} sub-agent${subagents === 1 ? "" : "s"}`;
}

/** How a finished turn ended, for the end-of-turn line. */
export interface TurnEnd {
  tone: "done" | "error" | "stopped";
  label: string;
  /** Turn duration for "done" (null when unknown). */
  elapsedMs: number | null;
}

/** How the latest turn (after the last prompt) ended: a user cancel leaves a "Turn cancelled" notice. */
export function turnOutcome(items: readonly TimelineItem[]): "done" | "cancelled" {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user_message") break;
    if (it.kind === "notice" && it.text === "Turn cancelled") return "cancelled";
  }
  return "done";
}

/**
 * The compact end-of-turn line shown where the thinking indicator was, or null. Exists for the
 * latest turn of every finished agent, except when a turn summary card is the last row (the card
 * carries the "Done" emphasis itself).
 */
export function turnEndOf(
  status: AgentStatus,
  items: readonly TimelineItem[],
  lastRow: TimelineItem | undefined,
  _lastActivityAt?: number,
): TurnEnd | null {
  if (status !== "idle" && status !== "error") return null;
  if (!lastRow || lastRow.kind === "turn_summary") return null;
  const start = items.findLast((i) => i.kind === "user_message");
  if (!start) return null;
  // An error notice is already the last row: don't say it a second time.
  if (status === "error" && lastRow.kind === "notice" && lastRow.level === "error") return null;
  if (status === "error") return { tone: "error", label: "Stopped with an error", elapsedMs: null };
  if (turnOutcome(items) === "cancelled") return { tone: "stopped", label: "Stopped", elapsedMs: null };
  // The turn's own end (its last item), not lastActivityAt: archive/rename/unread bump that.
  const end = items[items.length - 1] ?? start;
  const summary = items.findLast((i, idx) => i.kind === "turn_summary" && items[idx] && i.ts >= start.ts);
  const elapsed = summary && summary.kind === "turn_summary" ? summary.durationMs : end.ts - start.ts;
  return { tone: "done", label: "Done", elapsedMs: elapsed >= 0 ? elapsed : null };
}

/** Turns longer than this get the soft "you were watching" chime. */
export const LONG_TURN_MS = 30_000;

/** Statuses in which the "waiting on sub-agents" line may show (idle: the agent is just waiting too). */
export function waitingStatus(status: AgentStatus): boolean {
  return status === "working" || status === "starting" || status === "idle";
}

/** What a sub-agent inherits from its parent: the parent's current model / reasoning effort (display names). */
export interface Inherited {
  model: string | null;
  effort: string | null;
}

const NO_INHERIT: Inherited = { model: null, effort: null };

function optionName(opt: ConfigOption | undefined): string | null {
  if (!opt) return null;
  return opt.options.find((o) => o.value === opt.currentValue)?.name ?? (opt.currentValue || null);
}

/** The agent's own model and effort from its config options (null for whatever it doesn't expose). */
export function inheritedOf(options: readonly ConfigOption[] | undefined): Inherited {
  if (!options?.length) return NO_INHERIT;
  return {
    model: optionName(options.find((o) => o.category === "model")),
    effort: optionName(options.find((o) => o.category === "thought_level")),
  };
}

export interface SubagentChip {
  key: "model" | "effort";
  text: string;
  /** Not named by the launch: the parent's setting (or just "inherits"). */
  inherited: boolean;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Model and effort chips for a sub-agent. A value the launch named shows as is; otherwise "inherits <the
 * parent's value>" when the parent exposes one, and nothing when it doesn't (never invented).
 */
export function subagentChips(
  sub: { model?: string | null; effort?: string | null },
  parent: Inherited = NO_INHERIT,
): SubagentChip[] {
  const chips: SubagentChip[] = [];
  const model = sub.model?.trim();
  const effort = sub.effort?.trim();
  if (model) chips.push({ key: "model", text: model, inherited: false });
  else if (parent.model) chips.push({ key: "model", text: `inherits ${parent.model}`, inherited: true });
  if (effort) chips.push({ key: "effort", text: capitalize(effort), inherited: false });
  else if (parent.effort) chips.push({ key: "effort", text: `inherits ${parent.effort}`, inherited: true });
  return chips;
}
