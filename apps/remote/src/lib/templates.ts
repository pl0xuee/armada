/** Prompt templates in the composer: the desktop's placeholder rules, plus caret insertion and search. */
import type { PromptTemplate } from "./types";

// Same parsing as the desktop's template picker: `{{name}}` fields, unfilled ones stay as written.
export { fillTemplate, placeholderLabel, templatePlaceholders } from "@shared/templates";

/** Every field has something in it (the phone doesn't insert a template with `{{blanks}}` left in). */
export function allFieldsFilled(fields: readonly string[], values: Record<string, string>): boolean {
  return fields.every((f) => (values[f] ?? "").trim() !== "");
}

export type TemplatePart = { text: string } | { field: string };

/** A template's body split into plain text and `{{field}}` placeholders, to show the latter as chips. */
export function templateParts(body: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let last = 0;
  for (const m of body.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    if (m.index > last) parts.push({ text: body.slice(last, m.index) });
    parts.push({ field: m[1] });
    last = m.index + m[0].length;
  }
  if (last < body.length) parts.push({ text: body.slice(last) });
  return parts;
}

/** Templates whose name or text contains the query (case-insensitive); all of them for an empty query. */
export function filterTemplates(templates: PromptTemplate[], query: string): PromptTemplate[] {
  const q = query.trim().toLowerCase();
  return q ? templates.filter((t) => `${t.name} ${t.text}`.toLowerCase().includes(q)) : templates;
}

/**
 * Put `insert` into the composer text like the desktop: an empty box takes the
 * template whole; otherwise it replaces the selection (or goes at the caret).
 * Returns the new text and where the caret ends up (after the inserted text).
 */
export function insertAtCaret(text: string, insert: string, start: number | null, end: number | null): { text: string; caret: number } {
  if (!text.trim()) return { text: insert, caret: insert.length };
  const s = Math.min(Math.max(start ?? text.length, 0), text.length);
  const e = Math.min(Math.max(end ?? s, s), text.length);
  return { text: `${text.slice(0, s)}${insert}${text.slice(e)}`, caret: s + insert.length };
}
