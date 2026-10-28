// Exact raw slices of a unified/git patch, for `revert_patch`.
//
// The backend reverse-applies whatever text we send, so slices are cut straight out of
// `AgentDiff.patch` (never re-serialised from parsed lines): a file section is everything
// from its `diff --git` line to the next file; a hunk is its `@@` line up to the next `@@`
// (or the end of the file section). A hunk revert sends the file header + that one hunk.

export interface PatchHunkSlice {
  /** The `@@ -a,b +c,d @@ …` line. */
  header: string;
  /** Raw hunk text, from its `@@` line through its last line (newline-terminated). */
  text: string;
}

export interface PatchFileSlice {
  /** New path (old path for deletions), without the a/ b/ prefix, C-unquoted. */
  path: string;
  /** Previous path for renames, else null. */
  oldPath: string | null;
  /** Raw header lines from `diff --git` (or `---`) up to the first `@@` (newline-terminated). */
  header: string;
  /** The whole raw file section (header + all hunks). */
  text: string;
  hunks: PatchHunkSlice[];
}

/** Undo git's C-style quoting: "a/we\"ird\303\251" → a/weird… (octal escapes are UTF-8 bytes). */
export function cUnquote(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  const pushText = (t: string) => {
    for (const b of new TextEncoder().encode(t)) bytes.push(b);
  };
  const SIMPLE: Record<string, string> = {
    n: "\n",
    t: "\t",
    r: "\r",
    b: "\b",
    f: "\f",
    v: "\v",
    a: "\x07",
    '"': '"',
    "\\": "\\",
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\" || i === body.length - 1) {
      pushText(ch);
      continue;
    }
    const next = body[i + 1];
    if (/[0-7]/.test(next)) {
      const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))![0];
      bytes.push(parseInt(oct, 8) & 0xff);
      i += oct.length;
    } else {
      pushText(SIMPLE[next] ?? next);
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Path from a `---`/`+++` header value: unquote, drop the a/ b/ prefix and any trailing tab-timestamp. */
function headerPath(raw: string): string | null {
  let v = raw.trim();
  if (v.startsWith('"')) v = cUnquote(v);
  else v = v.replace(/\t.*$/, "");
  if (v === "/dev/null") return null;
  return v.replace(/^[ab]\//, "");
}

/** Split a raw patch into lines, keeping each line's own terminator. */
function rawLines(patch: string): string[] {
  return patch.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function isGitHeader(line: string) {
  return line.startsWith("diff --git ");
}

/** Path from `diff --git a/x b/y` (only used when there are no ---/+++ lines, e.g. binary or mode-only). */
function gitHeaderPath(line: string): string | null {
  const rest = line.slice("diff --git ".length).replace(/\r?\n$/, "");
  const quoted = /"((?:[^"\\]|\\.)*)"\s*$/.exec(rest);
  if (quoted) return cUnquote(`"${quoted[1]}"`).replace(/^b\//, "");
  // Unquoted: both halves are the same path when it isn't a rename, so split down the middle.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest.slice(0, half).replace(/^a\//, "") === rest.slice(half + 1).replace(/^b\//, "")) {
    return rest.slice(half + 1).replace(/^b\//, "");
  }
  const m = / b\/(.+)$/.exec(rest);
  return m ? m[1] : null;
}

/** Slice a patch into exact per-file and per-hunk raw text. */
export function slicePatch(patch: string): PatchFileSlice[] {
  const lines = rawLines(patch.replace(/\r\n/g, "\n"));
  // Section starts. Git patches split only on `diff --git` (a removed "-- x" line followed by an
  // added "++ y" inside a hunk must not look like a header). Plain unified diffs split on a
  // `---`/`+++` pair outside a hunk, tracking hunk bodies by their line counts.
  const starts: number[] = [];
  if (lines.some(isGitHeader)) {
    lines.forEach((l, i) => isGitHeader(l) && starts.push(i));
  } else {
    let oldLeft = 0;
    let newLeft = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const inHunk = oldLeft > 0 || newLeft > 0;
      if (inHunk) {
        if (l.startsWith("\\")) continue;
        if (l.startsWith("-")) oldLeft--;
        else if (l.startsWith("+")) newLeft--;
        else {
          oldLeft--;
          newLeft--;
        }
        continue;
      }
      const hm = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(l);
      if (hm) {
        oldLeft = hm[1] === undefined ? 1 : Number(hm[1]);
        newLeft = hm[2] === undefined ? 1 : Number(hm[2]);
        if (starts.length === 0) starts.push(i); // header-less hunks still form one section
        continue;
      }
      if (l.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) starts.push(i);
    }
  }

  const out: PatchFileSlice[] = [];
  starts.forEach((start, si) => {
    const end = si + 1 < starts.length ? starts[si + 1] : lines.length;
    const section = lines.slice(start, end);
    const firstHunk = section.findIndex((l) => l.startsWith("@@"));
    const headerLines = firstHunk < 0 ? section : section.slice(0, firstHunk);

    let path: string | null = null;
    let oldPath: string | null = null;
    let minus: string | null = null;
    let plus: string | null = null;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    for (const h of headerLines) {
      const v = h.replace(/\n$/, "");
      if (v.startsWith("--- ")) minus = headerPath(v.slice(4));
      else if (v.startsWith("+++ ")) plus = headerPath(v.slice(4));
      else if (v.startsWith("rename from ")) renameFrom = headerPath(v.slice(12));
      else if (v.startsWith("rename to ")) renameTo = headerPath(v.slice(10));
    }
    path = renameTo ?? plus ?? minus ?? (isGitHeader(section[0]) ? gitHeaderPath(section[0]) : null) ?? "";
    if (renameFrom && renameFrom !== path) oldPath = renameFrom;
    else if (minus && plus && minus !== plus) oldPath = minus;

    const hunks: PatchHunkSlice[] = [];
    if (firstHunk >= 0) {
      let cur: string[] | null = null;
      for (const l of section.slice(firstHunk)) {
        if (l.startsWith("@@")) {
          if (cur) hunks.push({ header: cur[0].replace(/\n$/, ""), text: cur.join("") });
          cur = [l];
        } else if (cur) {
          cur.push(l);
        }
      }
      if (cur) hunks.push({ header: cur[0].replace(/\n$/, ""), text: cur.join("") });
    }

    out.push({
      path,
      oldPath,
      header: ensureNewline(headerLines.join("")),
      text: ensureNewline(section.join("")),
      hunks: hunks.map((h) => ({ ...h, text: ensureNewline(h.text) })),
    });
  });
  return out;
}

function ensureNewline(s: string): string {
  return s === "" || s.endsWith("\n") ? s : `${s}\n`;
}

/** The patch to revert one hunk: the file's header lines plus exactly that hunk. */
export function hunkPatch(file: PatchFileSlice, hunkIndex: number): string | null {
  const h = file.hunks[hunkIndex];
  return h ? file.header + h.text : null;
}

/** Find a file's slice by exact path, then by path suffix (chips may carry relative or absolute paths). */
export function findFileSlice(files: PatchFileSlice[], path: string): PatchFileSlice | undefined {
  const norm = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return (
    files.find((f) => f.path === norm) ?? files.find((f) => norm.endsWith(`/${f.path}`) || f.path.endsWith(`/${norm}`))
  );
}
