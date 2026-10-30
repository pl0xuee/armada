import type { FileDiff } from "./types";

function lines(text: string | null): string[] {
  if (!text) return [];
  const out = text.split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * +/- counts without diffing (the desktop's `cheapStats`): exact for unified diffs; for old/new
 * texts, a multiset line comparison (exact for pure additions/deletions, a close upper bound otherwise).
 */
export function cheapStats(d: FileDiff): { additions: number; deletions: number } {
  if (d.unified && d.unified.trim()) {
    let additions = 0;
    let deletions = 0;
    for (const l of d.unified.split("\n")) {
      if (l.startsWith("+") && !l.startsWith("+++ ")) additions++;
      else if (l.startsWith("-") && !l.startsWith("--- ")) deletions++;
    }
    return { additions, deletions };
  }
  const counts = new Map<string, number>();
  for (const l of lines(d.oldText)) counts.set(l, (counts.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of lines(d.newText)) {
    const c = counts.get(l) ?? 0;
    if (c > 0) counts.set(l, c - 1);
    else additions++;
  }
  let deletions = 0;
  for (const c of counts.values()) deletions += c;
  return { additions, deletions };
}

export function cheapStatsAll(diffs: FileDiff[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const d of diffs) {
    const s = cheapStats(d);
    additions += s.additions;
    deletions += s.deletions;
  }
  return { additions, deletions };
}
