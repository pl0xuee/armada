// Pure logic behind the question card: grouping "Other" boxes with their choice field,
// turning what the user typed/picked into the answers object, validation and read-only summaries.
import type { QuestionAnswers, QuestionField, TimelineItem } from "./types";

export type QuestionItem = Extract<TimelineItem, { kind: "question" }>;

/** A field plus the free-text "Other" box that belongs to it, if any. */
export interface QuestionGroup {
  field: QuestionField;
  other: QuestionField | null;
}

/** What the user has entered so far, by field id. */
export interface QuestionDraft {
  /** Picked option values of single/multi fields. */
  picks: Record<string, string[]>;
  /** The "Other" row of a choice field is selected. */
  otherOn: Record<string, boolean>;
  /** Raw text: text and number fields, and "Other" boxes (by their own id). */
  texts: Record<string, string>;
  bools: Record<string, boolean>;
}

export const EMPTY_DRAFT: QuestionDraft = { picks: {}, otherOn: {}, texts: {}, bools: {} };

const isChoice = (f: QuestionField) => f.kind === "single" || f.kind === "multi";

/** Fields in order, with each `otherFor` companion folded into the choice field it belongs to. */
export function questionGroups(fields: QuestionField[]): QuestionGroup[] {
  const choiceIds = new Set(fields.filter(isChoice).map((f) => f.id));
  const others = new Map<string, QuestionField>();
  for (const f of fields) {
    if (f.otherFor && choiceIds.has(f.otherFor) && !others.has(f.otherFor)) others.set(f.otherFor, f);
  }
  const folded = new Set([...others.values()].map((f) => f.id));
  return fields.filter((f) => !folded.has(f.id)).map((field) => ({ field, other: others.get(field.id) ?? null }));
}

/** A number field's text as a number, or null when it isn't one. */
export function parseNumber(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** The other box's text when its row is selected. */
function otherText(g: QuestionGroup, d: QuestionDraft): string {
  if (!g.other || !d.otherOn[g.field.id]) return "";
  return (d.texts[g.other.id] ?? "").trim();
}

/** The answers the draft amounts to; unanswered fields are left out. */
export function buildAnswers(fields: QuestionField[], d: QuestionDraft): QuestionAnswers {
  const out: QuestionAnswers = {};
  for (const g of questionGroups(fields)) {
    const f = g.field;
    switch (f.kind) {
      case "single": {
        const extra = otherText(g, d);
        if (extra && g.other) out[g.other.id] = extra;
        else if (!d.otherOn[f.id] && d.picks[f.id]?.[0] !== undefined) out[f.id] = d.picks[f.id][0];
        break;
      }
      case "multi": {
        const picks = d.picks[f.id] ?? [];
        if (picks.length) out[f.id] = picks;
        const extra = otherText(g, d);
        if (extra && g.other) out[g.other.id] = extra;
        break;
      }
      case "text": {
        const t = (d.texts[f.id] ?? "").trim();
        if (t) out[f.id] = t;
        break;
      }
      case "number": {
        const n = parseNumber(d.texts[f.id] ?? "");
        if (n !== null) out[f.id] = n;
        break;
      }
      case "boolean":
        if (f.id in d.bools) out[f.id] = d.bools[f.id];
        break;
    }
  }
  return out;
}

/** Ids of required fields that still have no answer. */
export function missingRequired(fields: QuestionField[], d: QuestionDraft): string[] {
  const answers = buildAnswers(fields, d);
  return questionGroups(fields)
    .filter((g) => g.field.required && !(g.field.id in answers) && !(g.other && g.other.id in answers))
    .map((g) => g.field.id);
}

/** Submit is allowed: nothing required is missing and there is something to send. */
export function canSubmit(fields: QuestionField[], d: QuestionDraft): boolean {
  return missingRequired(fields, d).length === 0 && Object.keys(buildAnswers(fields, d)).length > 0;
}

/** Pick (or toggle, for multi) an option; picking in a single field leaves "Other". */
export function togglePick(d: QuestionDraft, g: QuestionGroup, value: string): QuestionDraft {
  const id = g.field.id;
  const cur = d.picks[id] ?? [];
  if (g.field.kind === "single") {
    return { ...d, picks: { ...d.picks, [id]: [value] }, otherOn: { ...d.otherOn, [id]: false } };
  }
  const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
  return { ...d, picks: { ...d.picks, [id]: next } };
}

/** Select/deselect the "Other" row (selecting it clears the pick of a single field). */
export function toggleOther(d: QuestionDraft, g: QuestionGroup): QuestionDraft {
  const id = g.field.id;
  const on = !d.otherOn[id];
  const picks = on && g.field.kind === "single" ? { ...d.picks, [id]: [] } : d.picks;
  return { ...d, picks, otherOn: { ...d.otherOn, [id]: on } };
}

export function setText(d: QuestionDraft, id: string, text: string): QuestionDraft {
  return { ...d, texts: { ...d.texts, [id]: text } };
}

export function setBool(d: QuestionDraft, id: string, value: boolean): QuestionDraft {
  return { ...d, bools: { ...d.bools, [id]: value } };
}

/** Index of the first group still without an answer (else 0): where keys act. */
export function firstOpenGroup(groups: QuestionGroup[], d: QuestionDraft): number {
  const answers = buildAnswers(
    groups.flatMap((g) => (g.other ? [g.field, g.other] : [g.field])),
    d,
  );
  const i = groups.findIndex((g) => !(g.field.id in answers) && !(g.other && g.other.id in answers));
  return i < 0 ? 0 : i;
}

export interface AnswerChip {
  text: string;
  /** Typed into an "Other" box rather than picked. */
  custom: boolean;
}

export interface AnswerSummary {
  id: string;
  title: string;
  chips: AnswerChip[];
}

/** Compact read-only view of an answered question, one entry per answered field. */
export function summarizeAnswers(item: QuestionItem): AnswerSummary[] {
  const answers = item.answers ?? {};
  const out: AnswerSummary[] = [];
  for (const g of questionGroups(item.fields)) {
    const f = g.field;
    const chips: AnswerChip[] = [];
    const raw = answers[f.id];
    const label = (v: string) => f.options?.find((o) => o.value === v)?.label ?? v;
    if (raw !== undefined) {
      if (Array.isArray(raw)) chips.push(...raw.map((v) => ({ text: label(v), custom: false })));
      else if (typeof raw === "boolean") chips.push({ text: raw ? "Yes" : "No", custom: false });
      else if (typeof raw === "number") chips.push({ text: String(raw), custom: false });
      else if (f.secret) chips.push({ text: "••••••••", custom: false });
      else chips.push({ text: isChoice(f) ? label(raw) : raw, custom: false });
    }
    const extra = g.other ? answers[g.other.id] : undefined;
    if (typeof extra === "string" && extra) chips.push({ text: extra, custom: true });
    if (chips.length) out.push({ id: f.id, title: f.title || f.description || f.id, chips });
  }
  return out;
}

/** Newest unresolved question in a timeline. */
export function latestPendingQuestion(items: TimelineItem[] | undefined): QuestionItem | null {
  if (!items) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "question" && it.resolution === null) return it;
  }
  return null;
}
