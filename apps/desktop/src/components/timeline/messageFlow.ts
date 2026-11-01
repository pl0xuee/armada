import type { TimelineItem } from "@/lib/types";

/**
 * Agent messages that touch each other in the conversation (nothing visible between them) are one
 * piece of writing. The backend starts a new message item whenever its stream is interrupted (a tool
 * call that is shown inside a sub-agent card, a call held back for attribution, a picture), so a
 * sentence can be cut in two; rendering each half as its own block shows a paragraph break in the
 * middle of it. These helpers stitch such runs back together.
 */

/** Last line is block-level markdown (heading, list item, quote, table row, fence): it ends a block without punctuation. */
const BLOCK_LINE_RE = /^\s*(?:#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s|>|\||`{3,}|~{3,})/;
/** A sentence (or a clause that introduces what follows) ended: possibly closed by quotes, brackets or emphasis marks. */
const SENTENCE_END_RE = /[.!?:;…。！？][)\]}"'”’*_`~]*$/;
/** Starts like the continuation of a sentence rather than a new one. */
const CONTINUES_RE = /^[a-z0-9,;:)\]}.!?'’"”-]/;

/**
 * Text of two consecutive messages as one flow. Mid-sentence cuts are joined (with a space when
 * neither side has one); a finished sentence, paragraph or block gets normal paragraph spacing.
 */
export function joinMessageText(prev: string, next: string): string {
  if (!prev.trim()) return next;
  if (!next.trim()) return prev;
  // Blank line already there: nothing to repair.
  if (/\n[ \t]*\n[ \t]*$/.test(prev) || /^[ \t]*\n[ \t]*\n/.test(next)) return prev + next;
  const head = prev.trimEnd();
  const lastLine = head.slice(head.lastIndexOf("\n") + 1);
  const tail = next.trimStart();
  const continues = CONTINUES_RE.test(tail);
  const blockEnd = BLOCK_LINE_RE.test(lastLine) && !continues;
  if (blockEnd || SENTENCE_END_RE.test(head)) return `${head}\n\n${tail}`;
  // Cut mid-sentence: one flow. Keep whatever whitespace the stream already carried.
  if (/\s$/.test(prev) || /^\s/.test(next)) return prev + next;
  // A cut inside a word is only possible when both sides are letters; the writer never splits a token
  // across two items, so assume a missing word break.
  return `${prev} ${next}`;
}

export interface MessageRuns {
  /** Row indices with each run of consecutive messages replaced by its first index. */
  rows: number[];
  /** Run members (indices into `items`) keyed by the first member's index. Always >= 2 members. */
  runs: Map<number, number[]>;
}

/** A message that is only words: pictures keep their own row so text stays in order around them. */
function isTextMessage(it: TimelineItem | undefined): boolean {
  return it?.kind === "agent_message" && !(it.images && it.images.length > 0);
}

/**
 * Merge runs of consecutive text messages in `rows` (top-level row indices, in order) into one row.
 * Depends on item kinds only, so a run grows in place (its row, id and position never change) when
 * the next piece arrives.
 */
export function stitchMessages(items: TimelineItem[], rows: number[]): MessageRuns {
  const out: number[] = [];
  const runs = new Map<number, number[]>();
  let run: number[] | null = null;
  for (const i of rows) {
    if (!isTextMessage(items[i])) {
      run = null;
      out.push(i);
    } else if (run) run.push(i);
    else {
      run = [i];
      out.push(i);
    }
    if (run && run.length > 1) runs.set(run[0], run);
  }
  return { rows: out, runs };
}

/** Text of a run's messages as one flow. */
export function runText(parts: readonly TimelineItem[]): string {
  let text = "";
  for (const p of parts) if (p.kind === "agent_message") text = joinMessageText(text, p.text);
  return text;
}
