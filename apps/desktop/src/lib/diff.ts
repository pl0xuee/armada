import { structuredPatch } from "diff";
import type { FileDiff } from "./types";

export type DiffLineType = "context" | "add" | "del";

export interface DiffLine {
  type: DiffLineType;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface ParsedFileDiff {
  path: string;
  oldPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed";
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  binary: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Decode a git C-quoted path (`"a/we\"ird \303\251"`): octal escapes are UTF-8 bytes;
 * also \" \\ \t \n \r \a \b \f \v. Unquoted input is returned as is.
 */
export function cUnquote(raw: string): string {
  const s = raw.trim();
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  const enc = new TextEncoder();
  const simple: Record<string, string> = {
    '"': '"',
    "\\": "\\",
    t: "\t",
    n: "\n",
    r: "\r",
    a: "\x07",
    b: "\b",
    f: "\f",
    v: "\v",
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\" || i === body.length - 1) {
      // Encode literal chars (incl. non-ASCII, astral) as UTF-8 too.
      const cp = body.codePointAt(i) ?? 0;
      const lit = String.fromCodePoint(cp);
      bytes.push(...enc.encode(lit));
      if (lit.length === 2) i++;
      continue;
    }
    const next = body[i + 1];
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4));
    if (oct) {
      bytes.push(parseInt(oct[0], 8) & 0xff);
      i += 3;
    } else if (next in simple) {
      bytes.push(...enc.encode(simple[next]));
      i += 1;
    } else {
      bytes.push(...enc.encode(next));
      i += 1;
    }
  }
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

/** Path from a `---`/`+++`/rename line: drops a trailing tab (timestamp), unquotes, strips a/ b/. */
function stripPrefix(p: string): string {
  let clean = p.trim().startsWith('"') ? p.trim() : p.replace(/\t.*$/, "").trim();
  clean = cUnquote(clean);
  if (clean === "/dev/null") return clean;
  return clean.replace(/^[ab]\//, "");
}

/** Read one possibly-quoted path token from the start of `s`; returns [token, rest]. */
function readQuoted(s: string): [string, string] | null {
  if (!s.startsWith('"')) return null;
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === '"') return [s.slice(0, i + 1), s.slice(i + 1)];
  }
  return null;
}

/**
 * Old/new paths from a `diff --git A B` header. Quoted tokens are exact; unquoted ones are
 * ambiguous when paths contain " b/", so prefer the symmetric split (same path on both sides).
 * Callers should still prefer ---/+++ and rename lines, which are unambiguous.
 */
export function parseGitHeader(line: string): { oldPath: string; newPath: string } | null {
  const rest = line.slice("diff --git ".length);
  const strip = (t: string) => cUnquote(t).replace(/^[ab]\//, "");
  const q = readQuoted(rest);
  if (q) {
    const second = q[1].trimStart();
    const q2 = readQuoted(second);
    return { oldPath: strip(q[0]), newPath: strip(q2 ? q2[0] : second) };
  }
  if (rest.endsWith('"')) {
    // Unquoted a-path, quoted b-path.
    const start = rest.lastIndexOf(' "');
    if (start > 0) return { oldPath: strip(rest.slice(0, start)), newPath: strip(rest.slice(start + 1)) };
  }
  // Symmetric: "a/P b/P".
  if ((rest.length - 1) % 2 === 0) {
    const half = (rest.length - 1) / 2;
    const left = rest.slice(0, half);
    const right = rest.slice(half + 1);
    if (rest[half] === " " && left.startsWith("a/") && right.startsWith("b/") && left.slice(2) === right.slice(2)) {
      return { oldPath: left.slice(2), newPath: right.slice(2) };
    }
  }
  // Rename without quoting: split at the last " b/" (ambiguous; ---/+++ lines refine it).
  const at = rest.lastIndexOf(" b/");
  if (rest.startsWith("a/") && at > 0) return { oldPath: rest.slice(2, at), newPath: rest.slice(at + 3) };
  return null;
}

/**
 * Parse a (possibly multi-file, possibly git-style) unified diff.
 * Hunks without file headers are attributed to `fallbackPath`.
 */
export function parseUnified(patch: string, fallbackPath = "changes"): ParsedFileDiff[] {
  const files: ParsedFileDiff[] = [];
  let file: ParsedFileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  // Lines still expected in the current hunk (from its header counts). While > 0, a
  // "--- " line is a deleted line, not a file header.
  let remOld = 0;
  let remNew = 0;

  const startFile = (path: string): ParsedFileDiff => {
    const f: ParsedFileDiff = {
      path,
      oldPath: null,
      status: "modified",
      hunks: [],
      additions: 0,
      deletions: 0,
      binary: false,
    };
    files.push(f);
    hunk = null;
    remOld = remNew = 0;
    return f;
  };

  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inBody = hunk !== null && (remOld > 0 || remNew > 0);

    if (line.startsWith("diff --git ")) {
      const h = parseGitHeader(line);
      file = startFile(h ? h.newPath : fallbackPath);
      if (h && h.oldPath !== h.newPath) {
        file.oldPath = h.oldPath;
        file.status = "renamed";
      }
      continue;
    }

    // File headers (outside a hunk body, and only as a ---/+++ pair).
    if (!inBody && line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      const oldP = stripPrefix(line.slice(4));
      const newP = stripPrefix(lines[i + 1].slice(4));
      if (!file || file.hunks.length > 0) file = startFile(newP === "/dev/null" ? oldP : newP);
      else file.path = newP === "/dev/null" ? oldP : newP;
      if (oldP === "/dev/null") file.status = "added";
      else if (newP === "/dev/null") file.status = "deleted";
      else if (oldP !== newP) {
        file.status = "renamed";
        file.oldPath = oldP;
      } else if (file.status === "renamed" && file.oldPath === null) {
        file.status = "modified";
      }
      hunk = null;
      i++;
      continue;
    }

    if (file && !inBody && !line.startsWith("@@")) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("Binary files")) file.binary = true;
      else if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
        file.oldPath = stripPrefix(line.slice(line.indexOf(" from ") + 6));
        file.status = "renamed";
        continue;
      } else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
        file.path = stripPrefix(line.slice(line.indexOf(" to ") + 4));
        file.status = "renamed";
        continue;
      }
      if (!hunk) continue;
    }

    // A hunk header can never be a body line (those start with " ", "+", "-" or "\\"),
    // so it always opens a new hunk, even if the previous one's counts were off.
    const hm = HUNK_RE.exec(line);
    if (hm) {
      if (!file) file = startFile(fallbackPath);
      oldNo = Number(hm[1]);
      newNo = Number(hm[3]);
      remOld = hm[2] === undefined ? 1 : Number(hm[2]);
      remNew = hm[4] === undefined ? 1 : Number(hm[4]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }

    if (!hunk || !file) continue;
    const h: DiffHunk = hunk;
    const f: ParsedFileDiff = file;
    const tag = line[0];
    const text = line.slice(1);
    if (tag === "+") {
      h.lines.push({ type: "add", text, oldNo: null, newNo: newNo++ });
      f.additions++;
      remNew = Math.max(0, remNew - 1);
    } else if (tag === "-") {
      h.lines.push({ type: "del", text, oldNo: oldNo++, newNo: null });
      f.deletions++;
      remOld = Math.max(0, remOld - 1);
    } else if (tag === " " || line === "") {
      h.lines.push({ type: "context", text, oldNo: oldNo++, newNo: newNo++ });
      remOld = Math.max(0, remOld - 1);
      remNew = Math.max(0, remNew - 1);
    }
    // "\ No newline at end of file" and anything else is ignored.
  }

  return files;
}

/** Build a parsed diff from full old/new text (ACP style). */
export function diffFromTexts(path: string, oldText: string | null, newText: string | null): ParsedFileDiff {
  const patch = structuredPatch(path, path, oldText ?? "", newText ?? "", undefined, undefined, {
    context: 3,
  });
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  for (const h of patch.hunks) {
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
      } else if (tag === " ") {
        out.push({ type: "context", text, oldNo: o++, newNo: n++ });
      }
    }
    hunks.push({
      header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
      lines: out,
    });
  }
  return {
    path,
    oldPath: null,
    status: oldText === null || oldText === "" ? "added" : newText === null ? "deleted" : "modified",
    hunks,
    additions,
    deletions,
    binary: false,
  };
}

/** Normalize a contract FileDiff (either form) into parsed file diffs. */
export function parseFileDiff(d: FileDiff): ParsedFileDiff[] {
  if (d.unified && d.unified.trim()) {
    const parsed = parseUnified(d.unified, d.path);
    // Prefer the contract path when the unified diff had no headers.
    return parsed.map((p) => (p.path === "changes" ? { ...p, path: d.path } : p));
  }
  return [diffFromTexts(d.path, d.oldText, d.newText)];
}

export function diffStats(diffs: FileDiff[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const d of diffs) {
    for (const p of parseFileDiff(d)) {
      additions += p.additions;
      deletions += p.deletions;
    }
  }
  return { additions, deletions };
}
