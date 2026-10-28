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

function stripPrefix(p: string): string {
  const clean = p.replace(/\t.*$/, "").trim();
  if (clean === "/dev/null") return clean;
  return clean.replace(/^[ab]\//, "");
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
    return f;
  };

  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      file = startFile(m ? m[2] : fallbackPath);
      if (m && m[1] !== m[2]) {
        file.oldPath = m[1];
        file.status = "renamed";
      }
      continue;
    }

    // File headers. Only treat as header when outside a hunk body or followed by +++.
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      const oldP = stripPrefix(line.slice(4));
      const newP = stripPrefix(lines[i + 1].slice(4));
      if (!file || file.hunks.length > 0) file = startFile(newP === "/dev/null" ? oldP : newP);
      else file.path = newP === "/dev/null" ? oldP : newP;
      if (oldP === "/dev/null") file.status = "added";
      else if (newP === "/dev/null") file.status = "deleted";
      else if (oldP !== newP) {
        file.status = "renamed";
        file.oldPath = oldP;
      }
      hunk = null;
      i++;
      continue;
    }

    if (file && !hunk) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("Binary files")) file.binary = true;
      else if (line.startsWith("rename from ")) {
        file.oldPath = line.slice(12);
        file.status = "renamed";
      }
    }

    const hm = HUNK_RE.exec(line);
    if (hm) {
      if (!file) file = startFile(fallbackPath);
      oldNo = Number(hm[1]);
      newNo = Number(hm[3]);
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
    } else if (tag === "-") {
      h.lines.push({ type: "del", text, oldNo: oldNo++, newNo: null });
      f.deletions++;
    } else if (tag === " " || line === "") {
      h.lines.push({ type: "context", text, oldNo: oldNo++, newNo: newNo++ });
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
