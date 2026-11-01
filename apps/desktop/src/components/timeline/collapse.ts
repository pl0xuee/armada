/**
 * Progressive disclosure for long agent output: how tall a message may be before it folds behind
 * "Show more". Heights are in CSS px and follow the line heights of `.prose-chat` / `.prose-narration`
 * in globals.css (15px on 24px lines and 13.5px on 21px lines: whole pixels keep measured row heights exact).
 */

export type MessageRole =
  /** The closing message of the latest turn: what the reader came for. Folds only when enormous. */
  | "latest"
  /** The closing message of an earlier turn. */
  | "answer"
  /** A working note between tool calls. */
  | "narration";

/**
 * How a message is typeset: the closing message of a turn is the answer; everything else is a working
 * note. While the latest turn still runs, its newest message is the answer in the making until the agent
 * moves on to a tool call (`trailingActivity`): then it was narration all along.
 */
export function messageRole(m: {
  /** Closes its turn. */
  final: boolean;
  /** Closes the latest turn that has an answer. */
  latest: boolean;
  /** Tool calls, thoughts or approvals follow it in its turn. */
  trailingActivity: boolean;
  /** The agent is mid-turn (working, starting or waiting for approval). */
  turnOpen: boolean;
}): MessageRole {
  if (!m.final) return "narration";
  if (!m.latest) return "answer";
  return m.turnOpen && m.trailingActivity ? "narration" : "latest";
}

export const LINE_PX: Record<MessageRole, number> = { latest: 24, answer: 24, narration: 21 };
export const LINE_LIMIT: Record<MessageRole, number> = { latest: 60, answer: 18, narration: 6 };
/** Hiding less than this many lines isn't worth a control: the message just shows in full. */
export const SLACK_LINES = 2;

export function collapseLimitPx(role: MessageRole): number {
  return Math.round(LINE_LIMIT[role] * LINE_PX[role]);
}

/**
 * Whether a message of natural height `heightPx` folds. Never while it streams, and never when the
 * reader has already watched it grow in this view (it would jump under them).
 */
export function shouldCollapse(
  heightPx: number,
  role: MessageRole,
  state: { streaming: boolean; watched: boolean },
): boolean {
  if (state.streaming || state.watched) return false;
  return heightPx > collapseLimitPx(role) + SLACK_LINES * LINE_PX[role];
}

/** Approximate number of lines a fold hides, for the control's label. */
export function hiddenLines(heightPx: number, role: MessageRole): number {
  return Math.max(1, Math.round((heightPx - collapseLimitPx(role)) / LINE_PX[role]));
}

/** Code blocks: longer than this many lines they open folded to `CODE_PREVIEW_LINES`. */
export const CODE_COLLAPSE_LINES = 30;
export const CODE_PREVIEW_LINES = 14;

export function codeCollapses(lineCount: number, watched: boolean): boolean {
  return !watched && lineCount > CODE_COLLAPSE_LINES;
}
