// Ordering and filtering of the Review file list: text diffs first, binary / LFS / diff-less
// entries (often thousands in game repos) grouped after them and optionally hidden.

import type { ChangedFile } from "./types";
import type { PatchIndex } from "./patchIndex";

/** Binary, LFS, or without a textual diff: shown as a compact one-line row. */
export function isCompactFile(f: ChangedFile, index: Pick<PatchIndex, "has" | "isBinary">): boolean {
  return !!f.lfs || index.isBinary(f.path) || !index.has(f.path);
}

export function compactLabel(
  f: ChangedFile,
  index: Pick<PatchIndex, "has" | "isBinary">,
  truncated = false,
): string {
  if (f.lfs)
    return f.status === "added"
      ? "LFS object · new"
      : f.status === "deleted"
        ? "LFS object · removed"
        : "LFS object · size changed";
  if (index.isBinary(f.path)) return "Binary file";
  // Past the 8 MB cut the file simply isn't in the patch: don't claim it has no text diff.
  return truncated && !index.has(f.path) ? "Diff not loaded (over 8 MB)" : "No textual diff";
}

export interface OrderedFiles {
  /** Files to show, text first (original order within each group). */
  list: ChangedFile[];
  textCount: number;
  compactCount: number;
}

export function orderReviewFiles(
  files: ChangedFile[],
  index: Pick<PatchIndex, "has" | "isBinary">,
  hideCompact: boolean,
): OrderedFiles {
  const text: ChangedFile[] = [];
  const compact: ChangedFile[] = [];
  for (const f of files) (isCompactFile(f, index) ? compact : text).push(f);
  return {
    list: hideCompact ? text : text.concat(compact),
    textCount: text.length,
    compactCount: compact.length,
  };
}

/** Changed lines above which a file's diff starts collapsed. */
export const BIG_FILE_LINES = 2000;

export function isBigFile(f: Pick<ChangedFile, "additions" | "deletions">): boolean {
  return f.additions + f.deletions > BIG_FILE_LINES;
}

/** Hide compact rows by default once there are this many (they would bury the real changes). */
export const HIDE_COMPACT_DEFAULT_OVER = 100;

/**
 * Guards against out-of-order async results: `begin()` hands out a token, and only the
 * latest token is still `current` (also false after `cancel()`).
 */
export function createLatest() {
  let n = 0;
  return {
    begin: () => ++n,
    isCurrent: (token: number) => token === n,
    cancel: () => {
      n++;
    },
  };
}
