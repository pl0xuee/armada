const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Unique placeholder names in order of first appearance. */
export function templatePlaceholders(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(PLACEHOLDER)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export function fillTemplate(body: string, values: Record<string, string>): string {
  return body.replace(PLACEHOLDER, (whole, name: string) => {
    const v = values[name.trim()];
    return v && v.trim() ? v.trim() : whole;
  });
}

/** "target_file" -> "Target file" */
export function placeholderLabel(name: string): string {
  const s = name.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
