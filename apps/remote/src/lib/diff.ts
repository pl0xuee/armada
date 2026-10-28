import type { FileDiff } from "./types";

export type DiffLineType = "ctx" | "add" | "del" | "gap" | "hunk";

export interface DiffLine {
  type: DiffLineType;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface ParsedDiff {
  path: string;
  lines: DiffLine[];
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified";
  /** Lines were dropped to keep rendering cheap. */
  truncated: boolean;
  /** Inputs too big to diff on a phone: no lines, counts are line totals. */
  tooLarge?: boolean;
}

/** Above this many characters (old + new) the line diff isn't computed. */
export const MAX_DIFF_INPUT = 400_000;

const CONTEXT = 3;
const MAX_LINES = 1500;
/** Max edit distance for Myers before falling back to "replace everything". */
const MAX_EDITS = 1200;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type Op = { t: "eq" | "add" | "del"; text: string };

/** Myers O((N+M)·D) line diff. Returns null when the edit distance exceeds `limit`. */
function myers(a: string[], b: string[], limit: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let end = -1;
  for (let d = 0; d <= max; d++) {
    if (d > limit) return null;
    trace.push(v.slice(off - d - 1, off + d + 2)); // k in [-d-1, d+1]
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        end = d;
        break;
      }
    }
    if (end >= 0) break;
  }
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = end; d > 0; d--) {
    const snap = trace[d];
    const g = (k: number) => snap[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && g(k - 1) < g(k + 1)) ? k + 1 : k - 1;
    const prevX = g(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: "eq", text: a[x - 1] });
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push({ t: "add", text: b[y - 1] });
      y--;
    } else {
      ops.push({ t: "del", text: a[x - 1] });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ t: "eq", text: a[x - 1] });
    x--;
    y--;
  }
  return ops.reverse();
}

export function diffLines(oldText: string, newText: string): Op[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle = myers(midA, midB, MAX_EDITS) ?? [
    ...midA.map((text): Op => ({ t: "del", text })),
    ...midB.map((text): Op => ({ t: "add", text })),
  ];
  return [
    ...a.slice(0, start).map((text): Op => ({ t: "eq", text })),
    ...middle,
    ...a.slice(endA).map((text): Op => ({ t: "eq", text })),
  ];
}

/** Turn edit ops into display lines, keeping CONTEXT lines around changes. */
function toHunks(ops: Op[]): { lines: DiffLine[]; additions: number; deletions: number } {
  const all: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.t === "eq") all.push({ type: "ctx", text: op.text, oldNo: oldNo++, newNo: newNo++ });
    else if (op.t === "del") {
      deletions++;
      all.push({ type: "del", text: op.text, oldNo: oldNo++, newNo: null });
    } else {
      additions++;
      all.push({ type: "add", text: op.text, oldNo: null, newNo: newNo++ });
    }
  }
  const keep = new Uint8Array(all.length);
  all.forEach((l, i) => {
    if (l.type === "ctx") return;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(all.length - 1, i + CONTEXT); j++) keep[j] = 1;
  });
  const lines: DiffLine[] = [];
  let hidden = 0;
  for (let i = 0; i < all.length; i++) {
    if (keep[i]) {
      if (hidden) lines.push({ type: "gap", text: `${hidden} unchanged line${hidden === 1 ? "" : "s"}`, oldNo: null, newNo: null });
      hidden = 0;
      lines.push(all[i]);
    } else hidden++;
  }
  if (hidden && lines.length) lines.push({ type: "gap", text: `${hidden} unchanged line${hidden === 1 ? "" : "s"}`, oldNo: null, newNo: null });
  return { lines, additions, deletions };
}

function cap(d: ParsedDiff): ParsedDiff {
  if (d.lines.length <= MAX_LINES) return d;
  return { ...d, lines: d.lines.slice(0, MAX_LINES), truncated: true };
}

/** Parse a unified diff (possibly several files) into display lines. */
export function parseUnified(unified: string, fallbackPath: string): ParsedDiff[] {
  const files: ParsedDiff[] = [];
  let cur: ParsedDiff | null = null;
  let oldNo = 0;
  let newNo = 0;
  const lines = unified.split(/\r?\n/);
  const start = (path: string): ParsedDiff => {
    const d: ParsedDiff = { path, lines: [], additions: 0, deletions: 0, status: "modified", truncated: false };
    files.push(d);
    return d;
  };
  const cleanPath = (p: string) => p.replace(/\t.*$/, "").trim().replace(/^[ab]\//, "");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      const m = / b\/(.+)$/.exec(line);
      cur = start(m ? m[1] : fallbackPath);
      continue;
    }
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      const from = cleanPath(line.slice(4));
      const to = cleanPath(lines[i + 1].slice(4));
      const path = to === "/dev/null" ? from : to;
      if (!cur || cur.lines.length) cur = start(path);
      else cur.path = path;
      if (from === "/dev/null") cur.status = "added";
      if (to === "/dev/null") cur.status = "deleted";
      i++;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      cur ??= start(fallbackPath);
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      cur.lines.push({ type: "hunk", text: hunk[3].trim(), oldNo: null, newNo: null });
      continue;
    }
    if (!cur) continue; // preamble (index lines, etc.)
    if (line.startsWith("+")) {
      cur.additions++;
      cur.lines.push({ type: "add", text: line.slice(1), oldNo: null, newNo: newNo++ });
    } else if (line.startsWith("-")) {
      cur.deletions++;
      cur.lines.push({ type: "del", text: line.slice(1), oldNo: oldNo++, newNo: null });
    } else if (line.startsWith(" ")) {
      cur.lines.push({ type: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (line === "" && i < lines.length - 1) {
      cur.lines.push({ type: "ctx", text: "", oldNo: oldNo++, newNo: newNo++ });
    }
    // "\ No newline at end of file", "index …", mode lines: ignored
  }
  return files.map(cap);
}

export function parseFileDiff(d: FileDiff): ParsedDiff[] {
  if (d.unified) return parseUnified(d.unified, d.path);
  const status: ParsedDiff["status"] = d.oldText === null ? "added" : d.newText === null ? "deleted" : "modified";
  const oldText = d.oldText ?? "";
  const newText = d.newText ?? "";
  if (oldText.length + newText.length > MAX_DIFF_INPUT) {
    const count = (t: string) => (t ? t.split("\n").length : 0);
    return [{ path: d.path, lines: [], additions: count(newText), deletions: count(oldText), status, truncated: true, tooLarge: true }];
  }
  const { lines, additions, deletions } = toHunks(diffLines(oldText, newText));
  return [cap({ path: d.path, lines, additions, deletions, status, truncated: false })];
}

export function diffStats(diffs: FileDiff[]): { additions: number; deletions: number; files: number } {
  let additions = 0;
  let deletions = 0;
  let files = 0;
  for (const d of diffs) {
    for (const p of parseFileDiff(d)) {
      additions += p.additions;
      deletions += p.deletions;
      files++;
    }
  }
  return { additions, deletions, files };
}
