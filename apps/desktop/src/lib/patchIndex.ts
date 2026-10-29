// Lazy view of a big multi-file patch. Finding where each file's section starts is a cheap
// string scan; parsing (the expensive part) happens per file, on demand, and is memoised.
// A review of thousands of files then costs one scan up front instead of parsing megabytes.

import { parseUnified, type ParsedFileDiff } from "./diff";
import { slicePatch, type PatchFileSlice } from "./patchSlices";

export interface PatchSection {
  path: string;
  /** Offsets into the patch (exclusive end). Unused for the plain-unified fallback. */
  start: number;
  end: number;
  binary: boolean;
}

/** Headers are a handful of lines; never look further than this for the first hunk. */
const HEADER_SCAN = 2048;
const GIT = "diff --git ";

export class PatchIndex {
  readonly sections: PatchSection[] = [];
  private readonly byPath = new Map<string, PatchSection>();
  private readonly texts: string[] | null;
  private readonly parsedCache = new Map<string, ParsedFileDiff>();
  private readonly sliceCache = new Map<string, PatchFileSlice | null>();

  constructor(private readonly patch: string) {
    if (patch.startsWith(GIT) || patch.includes(`\n${GIT}`)) {
      this.texts = null;
      const starts: number[] = [];
      if (patch.startsWith(GIT)) starts.push(0);
      // A body line always begins with " ", "+", "-" or "\", so "\ndiff --git " is a real header.
      for (let i = patch.indexOf(`\n${GIT}`); i >= 0; i = patch.indexOf(`\n${GIT}`, i + 1)) starts.push(i + 1);
      starts.forEach((start, n) => {
        const end = n + 1 < starts.length ? starts[n + 1] : patch.length;
        const head = patch.slice(start, Math.min(end, start + HEADER_SCAN));
        const at = head.indexOf("\n@@");
        const header = at >= 0 ? head.slice(0, at + 1) : head;
        const path = parseUnified(header)[0]?.path ?? "";
        const binary = /^Binary files |^GIT binary patch/m.test(header);
        this.add({ path, start, end, binary });
      });
    } else {
      // Plain unified diffs (no `diff --git` lines) are small; slice them eagerly.
      const slices = slicePatch(patch);
      this.texts = slices.map((s) => s.text);
      slices.forEach((s, i) => this.add({ path: s.path, start: i, end: i + 1, binary: false }));
    }
  }

  private add(s: PatchSection) {
    this.sections.push(s);
    if (!this.byPath.has(s.path)) this.byPath.set(s.path, s);
  }

  has(path: string): boolean {
    return this.byPath.has(path);
  }

  isBinary(path: string): boolean {
    return this.byPath.get(path)?.binary ?? false;
  }

  /** The exact raw section for a file, or null. */
  text(path: string): string | null {
    const s = this.byPath.get(path);
    if (!s) return null;
    if (this.texts) return this.texts[s.start] ?? null;
    const t = this.patch.slice(s.start, s.end);
    return t.endsWith("\n") ? t : `${t}\n`;
  }

  /** Parsed lines for one file (memoised). Null when the patch has no section for it. */
  parsed(path: string): ParsedFileDiff | null {
    const hit = this.parsedCache.get(path);
    if (hit) return hit;
    const text = this.text(path);
    if (text === null) return null;
    const all = parseUnified(text, path);
    const f = all.find((p) => p.path === path) ?? all[0];
    const out: ParsedFileDiff = f ?? {
      path,
      oldPath: null,
      status: "modified",
      hunks: [],
      additions: 0,
      deletions: 0,
      binary: this.isBinary(path),
    };
    if (this.isBinary(path)) out.binary = true;
    this.parsedCache.set(path, out);
    return out;
  }

  /** Raw file/hunk slices (for revert), memoised. */
  slice(path: string): PatchFileSlice | null {
    if (this.sliceCache.has(path)) return this.sliceCache.get(path) ?? null;
    const text = this.text(path);
    const s = text === null ? null : (slicePatch(text)[0] ?? null);
    this.sliceCache.set(path, s);
    return s;
  }
}
