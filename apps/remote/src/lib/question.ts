/**
 * Pure logic for question cards: which fields are shown, turning what the
 * user entered into the answers the server expects, validation, and the
 * read-only summary of an answered question.
 */
import type { QuestionAnswers, QuestionField, QuestionItem } from "./types";

/** What the user has entered so far, by field id (numbers are kept as typed). */
export type Draft = Record<string, string | string[] | boolean>;

export const isChoice = (f: QuestionField) => f.kind === "single" || f.kind === "multi";

/** The fields that are questions in their own right: "Other" boxes belong to their choice field. */
export function primaryFields(fields: QuestionField[]): QuestionField[] {
  const ids = new Set(fields.map((f) => f.id));
  return fields.filter((f) => !(f.otherFor && ids.has(f.otherFor) && isChoice(fields.find((g) => g.id === f.otherFor)!)));
}

/** The free-text "Other" companion of a choice field, if it has one. */
export function otherOf(fields: QuestionField[], id: string): QuestionField | null {
  return fields.find((f) => f.otherFor === id && f.id !== id) ?? null;
}

/** A number typed by the user (commas as decimal separators allowed), or null. */
export function parseNumber(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const text = (v: Draft[string] | undefined) => (typeof v === "string" ? v.trim() : "");

/** The answer for one field, or undefined when it is unanswered (or invalid). */
function answerFor(f: QuestionField, draft: Draft): string | string[] | boolean | number | undefined {
  const v = draft[f.id];
  switch (f.kind) {
    case "multi": {
      const picked = Array.isArray(v) ? v : [];
      // Keep the options' order, whatever order they were tapped in.
      const ordered = (f.options ?? []).map((o) => o.value).filter((x) => picked.includes(x));
      return ordered.length ? ordered : undefined;
    }
    case "boolean":
      return typeof v === "boolean" ? v : undefined;
    case "number":
      return typeof v === "string" ? (parseNumber(v) ?? undefined) : undefined;
    default:
      return text(v) || undefined;
  }
}

/** The body of POST …/question: answered fields only. */
export function buildAnswers(fields: QuestionField[], draft: Draft): QuestionAnswers {
  const out: QuestionAnswers = {};
  for (const f of fields) {
    const a = answerFor(f, draft);
    if (a !== undefined) out[f.id] = a;
  }
  return out;
}

/** Whether a field has an answer, counting its "Other" text for choice fields. */
function hasAnswer(fields: QuestionField[], f: QuestionField, draft: Draft): boolean {
  if (answerFor(f, draft) !== undefined) return true;
  const other = isChoice(f) ? otherOf(fields, f.id) : null;
  return !!other && answerFor(other, draft) !== undefined;
}

/** Ids of the required fields still unanswered, plus numbers that were typed but don't parse. */
export function problems(fields: QuestionField[], draft: Draft): string[] {
  const out: string[] = [];
  for (const f of primaryFields(fields)) {
    const raw = draft[f.id];
    if (f.kind === "number" && typeof raw === "string" && raw.trim() && parseNumber(raw) === null) out.push(f.id);
    else if (f.required && !hasAnswer(fields, f, draft)) out.push(f.id);
  }
  return out;
}

export const canSubmit = (fields: QuestionField[], draft: Draft) => problems(fields, draft).length === 0;

export interface SummaryRow {
  /** The field's title or description (null for a lone untitled question). */
  label: string | null;
  value: string;
}

const labelOf = (f: QuestionField) => f.title?.trim() || f.description?.trim() || null;

/** One string for an answer, with choice values shown as their option labels. */
function show(f: QuestionField, a: string | string[] | boolean | number): string {
  const name = (v: string) => f.options?.find((o) => o.value === v)?.label ?? v;
  if (Array.isArray(a)) return a.map(name).join(", ");
  if (typeof a === "boolean") return a ? "Yes" : "No";
  if (typeof a === "number") return String(a);
  return f.secret ? "••••••••" : name(a);
}

/** What was answered, per field, for the compact read-only view. */
export function summarize(item: QuestionItem): SummaryRow[] {
  const answers = item.answers ?? {};
  const rows: SummaryRow[] = [];
  const fields = primaryFields(item.fields);
  for (const f of fields) {
    const parts: string[] = [];
    const a = answers[f.id];
    if (a !== undefined && !(Array.isArray(a) && !a.length)) parts.push(show(f, a));
    const other = isChoice(f) ? otherOf(item.fields, f.id) : null;
    const o = other ? answers[other.id] : undefined;
    if (other && typeof o === "string" && o.trim()) parts.push(other.secret ? "••••••••" : o.trim());
    if (parts.length) rows.push({ label: fields.length > 1 ? labelOf(f) : null, value: parts.join(", ") });
  }
  return rows;
}

/** How the resolved question is labelled. */
export function resolutionText(resolution: string): string {
  return resolution === "skipped" ? "Skipped" : resolution === "cancelled" ? "Cancelled" : "Answered";
}

/** Rough height of an open question card, for the virtual list's first guess. */
export function estimateQuestion(item: QuestionItem): number {
  let h = 150;
  for (const f of primaryFields(item.fields)) {
    h += f.title || f.description ? 40 : 0;
    h += isChoice(f) ? 60 * ((f.options?.length ?? 0) + (otherOf(item.fields, f.id) ? 1 : 0)) : 56;
  }
  return h;
}
