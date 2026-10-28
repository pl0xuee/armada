// Cheap stats + lazy, cached, time-boxed structured diffs for timeline cards.
// jsdiff on a full rewrite of a 3k-line file costs ~1s on the main thread, so cards show
// line-count stats until expanded, and the real diff is computed once, with a timeout.
import { structuredPatch } from "diff";
import { parseUnified, type DiffHunk, type DiffLine, type ParsedFileDiff } from "@/lib/diff";
import type { FileDiff } from "@/lib/types";

const TIMEOUT_MS = 200;
const MAX_EDIT_LENGTH = 4000;
const CACHE_MAX = 64;

function lines(text: string | null): string[] {
  if (!text) return [];
  const out = text.split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * +/- counts without diffing: exact for unified diffs; for old/new texts, a multiset line
 * comparison (exact for pure additions/deletions, a close upper bound otherwise).
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
  const before = lines(d.oldText);
  const after = lines(d.newText);
  const counts = new Map<string, number>();
  for (const l of before) counts.set(l, (counts.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of after) {
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

/** Whole-file replacement hunk, used when the real diff would take too long. */
function replaceAll(path: string, before: string[], after: string[], status: ParsedFileDiff["status"]): ParsedFileDiff {
  const out: DiffLine[] = [
    ...before.map((text, i): DiffLine => ({ type: "del", text, oldNo: i + 1, newNo: null })),
    ...after.map((text, i): DiffLine => ({ type: "add", text, oldNo: null, newNo: i + 1 })),
  ];
  return {
    path,
    oldPath: null,
    status,
    hunks: out.length
      ? [{ header: `@@ -1,${before.length} +1,${after.length} @@ (too large to compare line by line)`, lines: out }]
      : [],
    additions: after.length,
    deletions: before.length,
    binary: false,
  };
}

function fromTexts(d: FileDiff): ParsedFileDiff {
  const status: ParsedFileDiff["status"] =
    d.oldText === null || d.oldText === "" ? "added" : d.newText === null ? "deleted" : "modified";
  const before = lines(d.oldText);
  const after = lines(d.newText);
  if (status !== "modified") return replaceAll(d.path, before, after, status);
  const patch = structuredPatch(d.path, d.path, d.oldText ?? "", d.newText ?? "", undefined, undefined, {
    context: 3,
    timeout: TIMEOUT_MS,
    maxEditLength: MAX_EDIT_LENGTH,
  });
  if (!patch) return replaceAll(d.path, before, after, status);
  let additions = 0;
  let deletions = 0;
  const hunks: DiffHunk[] = patch.hunks.map((h) => {
    let o = h.oldStart;
    let n = h.newStart;
    const out: DiffLine[] = [];
    for (const l of h.lines) {
      const tag = l[0];
      const text = l.slice(1);
      if (tag === "+") {
        out.push({ type: "add", text, oldNo: null, newNo: n++ });
        additions++;
      } else if (tag === "-") {
        out.push({ type: "del", text, oldNo: o++, newNo: null });
        deletions++;
      } else if (tag === " ") out.push({ type: "context", text, oldNo: o++, newNo: n++ });
    }
    return { header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, lines: out };
  });
  return { path: d.path, oldPath: null, status, hunks, additions, deletions, binary: false };
}

// LRU (Map preserves insertion order; re-insert on hit).
const cache = new Map<string, ParsedFileDiff[]>();

function key(ownerId: string, index: number, d: FileDiff): string {
  return `${ownerId}#${index}#${d.path}#${d.oldText?.length ?? -1}#${d.newText?.length ?? -1}#${d.unified?.length ?? -1}`;
}

/** Parsed diffs for a timeline item's FileDiffs, computed once per (item, content size). */
export function parsedDiffs(ownerId: string, diffs: FileDiff[]): ParsedFileDiff[] {
  const out: ParsedFileDiff[] = [];
  diffs.forEach((d, i) => {
    const k = key(ownerId, i, d);
    let hit = cache.get(k);
    if (hit) {
      cache.delete(k);
    } else {
      hit =
        d.unified && d.unified.trim()
          ? parseUnified(d.unified, d.path).map((p) => (p.path === "changes" ? { ...p, path: d.path } : p))
          : [fromTexts(d)];
    }
    cache.set(k, hit);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
    out.push(...hit);
  });
  return out;
}
