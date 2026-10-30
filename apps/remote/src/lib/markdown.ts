/**
 * Markdown parser for agent messages, producing a small AST that
 * `components/Markdown.tsx` renders as React elements (never HTML strings).
 *
 * Supported (the CommonMark + GFM subset the desktop app renders): ATX and
 * setext headings, paragraphs with hard line breaks, bold/italic/strike,
 * inline code, fenced and indented code blocks (also unterminated fences,
 * while streaming), ordered/unordered/task lists with nesting and loose or
 * tight spacing, block quotes, rules, GFM tables, links, images, bare URLs and
 * emails, backslash escapes and character references. Only http(s)/mailto
 * links are ever produced; images are never loaded from the network.
 *
 * Performance: agent output is untrusted and can be huge, so every pattern
 * is either linear or bounded. Block structure is detected with string
 * operations; inline regexes only ever see a WINDOW-sized slice; over-long
 * lines and paragraphs are rendered as plain text.
 */

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { t: "p"; text: string; plain?: boolean }
  | { t: "h"; level: number; text: string }
  | { t: "code"; lang: string; text: string }
  | {
      t: "list";
      ordered: boolean;
      start: number;
      items: Block[][];
      /** Blank lines between items or an item's blocks: paragraphs get their own spacing. */
      loose: boolean;
      /** Per item: GFM task state (`- [x]`), or null for a plain item. Present only if some item is a task. */
      checked?: (boolean | null)[];
    }
  | { t: "quote"; blocks: Block[] }
  | { t: "hr" }
  | { t: "table"; head: string[]; align: Align[]; rows: string[][] };

export type Inline =
  | string
  | { t: "code"; text: string }
  | { t: "link"; href: string | null; children: Inline[]; raw?: string }
  | { t: "image"; src: string; alt: string }
  | { t: "strong" | "em" | "del"; children: Inline[] }
  | { t: "br" }
  | { t: "caret" };

/** Private-use sentinel appended while streaming; rendered as a caret wherever the text ends. */
export const CARET = "";

/** Lines/paragraphs longer than this are shown verbatim (no markdown). */
export const MAX_FORMATTED = 10_000;
/** Inline patterns never look further ahead than this. */
const WINDOW = 2_000;
const MAX_DEPTH = 6;

// ---------------------------------------------------------------------------
// Block-level detection (string operations, no backtracking)

function leadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 32) n++;
  return n;
}

interface Fence {
  char: "`" | "~";
  len: number;
  indent: number;
  lang: string;
}

function fenceOpen(line: string): Fence | null {
  const indent = leadingSpaces(line);
  if (indent > 3) return null;
  const ch = line[indent];
  if (ch !== "`" && ch !== "~") return null;
  let n = indent;
  while (line[n] === ch) n++;
  const len = n - indent;
  if (len < 3) return null;
  const info = line.slice(n);
  if (ch === "`" && info.includes("`")) return null;
  const lang = info.trim().split(/[ \t]/, 1)[0] ?? "";
  return { char: ch, len, indent, lang };
}

function isFenceClose(line: string, f: Fence): boolean {
  const indent = leadingSpaces(line);
  if (indent > 3) return false;
  let n = indent;
  while (line[n] === f.char) n++;
  return n - indent >= f.len && line.slice(n).trim() === "";
}

const HEADING_OPEN = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;

function heading(line: string): { level: number; text: string } | null {
  const m = HEADING_OPEN.exec(line);
  if (!m) return null;
  let text = line.slice(m[0].length).trimEnd();
  // Optional closing sequence: " ##" at the end.
  let j = text.length;
  while (j > 0 && text[j - 1] === "#") j--;
  if (j < text.length && (j === 0 || text[j - 1] === " " || text[j - 1] === "\t")) text = text.slice(0, j).trimEnd();
  return { level: m[1].length, text };
}

function isHr(line: string): boolean {
  if (leadingSpaces(line) > 3) return false;
  const s = line.replace(/[ \t]/g, "");
  if (s.length < 3) return false;
  const c = s[0];
  if (c !== "-" && c !== "*" && c !== "_") return false;
  for (let i = 1; i < s.length; i++) if (s[i] !== c) return false;
  return true;
}

function quoteBody(line: string): string | null {
  const indent = leadingSpaces(line);
  if (indent > 3 || line[indent] !== ">") return null;
  const rest = line.slice(indent + 1);
  return rest.startsWith(" ") ? rest.slice(1) : rest;
}

const LIST_MARKER = /^( *)([-*+]|\d{1,9}[.)])([ \t]+|$)/;

function listItem(line: string): { indent: number; marker: string; ci: number; text: string } | null {
  const m = LIST_MARKER.exec(line);
  if (!m) return null;
  const indent = m[1].length;
  const ci = indent + m[2].length + Math.min(m[3].length || 1, 4);
  return { indent, marker: m[2], ci, text: line.slice(m[0].length) };
}

function isTableSep(line: string): boolean {
  let s = line.trim();
  if (!s.includes("-")) return false;
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  if (!s) return false;
  return s.split("|").every((c) => /^:?-+:?$/.test(c.trim()));
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "`") {
      inCode = !inCode;
      cur += ch;
    } else if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function startsBlock(line: string): boolean {
  return !!(fenceOpen(line) || heading(line) || isHr(line) || quoteBody(line) !== null || listItem(line));
}

/**
 * Whether `line` ends a paragraph that is in progress. Like CommonMark, only a
 * non-empty list item can interrupt one, and an ordered list only if it starts at 1.
 */
function interruptsParagraph(line: string): boolean {
  if (fenceOpen(line) || heading(line) || isHr(line) || quoteBody(line) !== null) return true;
  const li = listItem(line);
  return !!li && li.text.trim() !== "" && (!/\d/.test(li.marker) || parseInt(li.marker, 10) === 1);
}

/** The underline of a setext heading: `===` (level 1) or `---` (level 2). */
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;

/** Tabs in leading whitespace count as 4 spaces; fenced code keeps its tabs verbatim. */
function splitLines(src: string): string[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  if (!src.includes("\t")) return lines;
  let fence: Fence | null = null;
  return lines.map((line) => {
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
      return line;
    }
    if (line.length <= MAX_FORMATTED) {
      const open = fenceOpen(line);
      if (open) {
        fence = open;
        return line;
      }
    }
    return line.charCodeAt(0) === 9 || line.includes(" \t") ? line.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, "    ")) : line;
  });
}

/** GFM task marker at the start of a list item's text. */
const TASK = /^\[([ xX])\][ \t]+(?=\S)/;

export function parseBlocks(src: string, depth = 0): Block[] {
  const lines = splitLines(src);
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.length > MAX_FORMATTED) {
      blocks.push({ t: "p", text: line, plain: true });
      i++;
      continue;
    }

    const fence = fenceOpen(line);
    if (fence) {
      const strip = (l: string) => l.slice(Math.min(fence.indent, leadingSpaces(l)));
      const body: string[] = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i], fence)) {
        body.push(fence.indent ? strip(lines[i]) : lines[i]);
        i++;
      }
      i++; // closing fence (or past the end while a message is still streaming)
      blocks.push({ t: "code", lang: fence.lang, text: body.join("\n") });
      continue;
    }

    const h = heading(line);
    if (h) {
      blocks.push({ t: "h", level: h.level, text: h.text });
      i++;
      continue;
    }

    if (isHr(line)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }

    if (quoteBody(line) !== null) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim() && (quoteBody(lines[i]) !== null || !interruptsParagraph(lines[i]))) {
        body.push(quoteBody(lines[i]) ?? lines[i]);
        i++;
      }
      const text = body.join("\n");
      blocks.push({ t: "quote", blocks: depth < MAX_DEPTH ? parseBlocks(text, depth + 1) : [{ t: "p", text }] });
      continue;
    }

    const first = listItem(line);
    if (first) {
      const baseIndent = first.indent;
      const ordered = /\d/.test(first.marker);
      const start = ordered ? parseInt(first.marker, 10) : 1;
      const items: { ci: number; lines: string[]; fence: Fence | null }[] = [];
      let loose = false;
      let blankRun = false;
      while (i < lines.length) {
        const l = lines[i];
        const li = listItem(l);
        // A different bullet character (or "." vs ")") starts a new list.
        if (li && li.indent <= baseIndent + 1 && /\d/.test(li.marker) === ordered && li.marker.slice(-1) === first.marker.slice(-1)) {
          if (blankRun && items.length) loose = true;
          items.push({ ci: li.ci, lines: [" ".repeat(li.ci) + li.text], fence: li.text.length <= MAX_FORMATTED ? fenceOpen(li.text) : null });
          blankRun = false;
          i++;
          continue;
        }
        if (!l.trim()) {
          blankRun = true;
          i++;
          continue;
        }
        const cur = items[items.length - 1];
        if (leadingSpaces(l) >= Math.min(cur.ci, baseIndent + 2)) {
          // A blank line between two blocks of one item makes the list loose (blank lines inside code don't).
          if (blankRun) {
            cur.lines.push("");
            if (!cur.fence) loose = true;
          }
          const inner = l.slice(Math.min(cur.ci, leadingSpaces(l)));
          if (cur.fence) {
            if (isFenceClose(inner, cur.fence)) cur.fence = null;
          } else if (inner.length <= MAX_FORMATTED) cur.fence = fenceOpen(inner);
          cur.lines.push(l);
          blankRun = false;
          i++;
          continue;
        }
        if (!blankRun && !startsBlock(l)) {
          cur.lines.push(" ".repeat(cur.ci) + l.trim()); // lazy continuation
          i++;
          continue;
        }
        break;
      }
      let anyTask = false;
      const checked: (boolean | null)[] = [];
      const parsed = items.map(({ ci, lines: raw }) => {
        let task: boolean | null = null;
        const head = raw[0].slice(ci);
        const m = TASK.exec(head);
        if (m) {
          task = m[1] !== " ";
          raw[0] = " ".repeat(ci) + head.slice(m[0].length);
          anyTask = true;
        }
        checked.push(task);
        const body = raw.map((l) => l.slice(Math.min(ci, leadingSpaces(l)))).join("\n");
        return depth < MAX_DEPTH ? parseBlocks(body, depth + 1) : [{ t: "p", text: body } as Block];
      });
      blocks.push({ t: "list", ordered, start, items: parsed, loose, ...(anyTask ? { checked } : {}) });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      const align: Align[] = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(":");
        const r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : null;
      });
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ t: "table", head, align, rows });
      continue;
    }

    if (leadingSpaces(line) >= 4) {
      // Indented code block: runs until a non-blank line that isn't indented.
      const body: string[] = [];
      while (i < lines.length && (!lines[i].trim() || (leadingSpaces(lines[i]) >= 4 && lines[i].length <= MAX_FORMATTED))) {
        body.push(lines[i].slice(Math.min(4, leadingSpaces(lines[i]))));
        i++;
      }
      while (body.length && !body[body.length - 1].trim()) body.pop();
      blocks.push({ t: "code", lang: "", text: body.join("\n") });
      continue;
    }

    const para: string[] = [];
    let size = 0;
    let setext = 0;
    while (i < lines.length && lines[i].trim()) {
      const cur = lines[i];
      if (para.length) {
        if (cur.length <= MAX_FORMATTED && SETEXT.test(cur)) {
          setext = cur.trimStart()[0] === "=" ? 1 : 2;
          i++;
          break;
        }
        if (interruptsParagraph(cur)) break;
        if (cur.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) break;
        if (cur.length > MAX_FORMATTED) break;
      }
      // Trailing spaces stay (two of them are a hard line break); the final line is trimmed below.
      para.push(cur.trimStart());
      size += cur.length;
      i++;
    }
    const text = para.join("\n").trimEnd();
    if (setext && size <= MAX_FORMATTED) blocks.push({ t: "h", level: setext, text: text.replace(/\n[ \t]*/g, " ") });
    else blocks.push({ t: "p", text, plain: size > MAX_FORMATTED || undefined });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Inline

export function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (!/^(https?:|mailto:)/i.test(url)) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? u.href : null;
  } catch {
    return null;
  }
}

const ESCAPE = /\\([!-/:-@[-`{-~])/y; // any ASCII punctuation, as in CommonMark
// URL part allows one level of balanced parentheses, e.g. Wikipedia-style links. The whitespace around the
// destination is unambiguous (every optional part starts with a character the one before it can't match), so
// a failed match backtracks in linear time: `[a](` followed by thousands of spaces used to cost O(k^2).
const LINK =
  /!?\[((?:[^[\]\\]|\\.|\[[^\]]*\])*)\]\(\s*(?:(?:<([^<>\n]*)>|((?:[^\s()<>]|\([^\s()<>]*\))+))(?:\s+["'][^"']*["'])?\s*)?\)/y;
const ANGLE_URL = /<((?:https?:\/\/|mailto:)[^\s>]+)>/y;
const ANGLE_MAIL = /<([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)>/y;
const BARE_URL = /https?:\/\/[^\s<>"']+/y;
const BARE_WWW = /www\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:[/?#][^\s<>"']*)?/y;
const BARE_MAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/y;
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,9}));/y;
const TRIPLE_STAR = /\*\*\*(?=[^\s*])([\s\S]*?[^\s*])\*\*\*(?!\*)/y;
const TRIPLE_UNDER = /___(?=[^\s_])([\s\S]*?[^\s_])___(?!\w)/y;
const STRONG_STAR = /\*\*(?=\S)([\s\S]*?\S)\*\*/y;
const STRONG_UNDER = /__(?=\S)([\s\S]*?\S)__(?!\w)/y;
const EM_STAR = /\*(?=[^\s*])([\s\S]*?[^\s*\\])\*(?!\*)/y;
const EM_UNDER = /_(?=[^\s_])([\s\S]*?[^\s_\\])_(?!\w)/y;

const TILDE = 126;

/** Whether a UTF-16 code unit is whitespace in the sense of the regex `\s`. */
function isSpaceCode(c: number): boolean {
  return (
    c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

/** Positions of the "~" characters that can close a strikethrough: not preceded by whitespace or another "~". */
function strikeClosers(text: string): number[] {
  const out: number[] = [];
  for (let e = text.indexOf("~", 1); e !== -1; e = text.indexOf("~", e + 1)) {
    const prev = text.charCodeAt(e - 1);
    if (prev !== TILDE && !isSpaceCode(prev)) out.push(e);
  }
  return out;
}

/**
 * GFM strikethrough, ~one~ and ~~two~~, looking at most WINDOW characters ahead: the same match as
 * /(~~?)(?=[^\s~])([\s\S]*?[^\s~])\1(?!~)/y, but it only visits the "~" characters that can close
 * (`closers`, from strikeClosers) instead of scanning the whole window per opener (text full of
 * "~a ~a ~a" made that quadratic).
 */
function matchStrike(text: string, at: number, closers: readonly number[]): { len: number; body: string } | null {
  const ml = text.charCodeAt(at + 1) === TILDE ? 2 : 1;
  const first = text.charCodeAt(at + ml);
  if (!(first === first) || first === TILDE || isSpaceCode(first)) return null; // NaN: end of text
  const end = Math.min(text.length, at + WINDOW);
  // First closer after the opener's first character.
  let lo = 0;
  let hi = closers.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (closers[mid] < at + ml + 1) lo = mid + 1;
    else hi = mid;
  }
  for (; lo < closers.length && closers[lo] + ml <= end; lo++) {
    const e = closers[lo];
    if (ml === 2 && text.charCodeAt(e + 1) !== TILDE) continue;
    if (e + ml < end && text.charCodeAt(e + ml) === TILDE) continue;
    return { len: e + ml - at, body: text.slice(at + ml, e) };
  }
  return null;
}

/** The character references worth decoding in chat text (the HTML ones agents actually write). */
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", reg: "®", trade: "™", hellip: "…",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", rarr: "→",
  larr: "←", uarr: "↑", darr: "↓", harr: "↔", times: "×", divide: "÷", plusmn: "±", deg: "°", laquo: "«",
  raquo: "»", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", infin: "∞", ne: "≠", le: "≤",
  ge: "≥", check: "✓", hearts: "♥",
};

function decodeEntity(m: RegExpExecArray): string | null {
  if (m[3] !== undefined) return ENTITIES[m[3]] ?? null;
  const cp = m[1] !== undefined ? parseInt(m[1], 10) : parseInt(m[2], 16);
  return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : null;
}

/** The text of an inline run, without any markup (image alt text, link hints). */
export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((n) => (typeof n === "string" ? n : n.t === "code" ? n.text : n.t === "image" ? n.alt : "children" in n ? inlineText(n.children) : n.t === "br" ? " " : ""))
    .join("");
}

/** Sticky match at `at`, looking at most WINDOW characters ahead. */
function match(re: RegExp, text: string, at: number): RegExpExecArray | null {
  re.lastIndex = 0;
  return re.exec(text.slice(at, at + WINDOW));
}

/** Trim punctuation that is almost never part of a bare URL. */
function trimUrl(url: string): string {
  let u = url.replace(/[.,;:!?*_~]+$/, "");
  while (u.endsWith(")") && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) u = u.slice(0, -1);
  return u;
}

const isWord = (ch: string | undefined) => !!ch && /\w/.test(ch);

export function parseInline(text: string, depth = 0, inLink = false): Inline[] {
  if (text.length > MAX_FORMATTED) return [text.split(CARET).join(""), ...(text.includes(CARET) ? [{ t: "caret" } as const] : [])];
  const out: Inline[] = [];
  let closers: number[] | undefined; // strikethrough closers, found on first use
  let buf = "";
  const flush = () => {
    if (buf) out.push(buf);
    buf = "";
  };
  const push = (node: Inline) => {
    flush();
    out.push(node);
  };
  const inner = (s: string, link = inLink) => (depth < MAX_DEPTH ? parseInline(s, depth + 1, link) : [s]);
  // Cheap guards so the autolink patterns only run where they can match.
  const hasAt = !inLink && text.includes("@");
  // For each backtick-run length, the position from which no closing run exists.
  const noCloser = new Map<number, number>();

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    let m: RegExpExecArray | null;
    let st: ReturnType<typeof matchStrike>;

    if (ch === CARET) {
      push({ t: "caret" });
      i++;
      continue;
    }
    if (ch === "\\") {
      if (text[i + 1] === "\n") {
        push({ t: "br" }); // backslash hard line break
        i += 2;
        continue;
      }
      ESCAPE.lastIndex = i;
      if ((m = ESCAPE.exec(text))) {
        buf += m[1];
        i += m[0].length;
        continue;
      }
    }
    if (ch === "`") {
      let n = i;
      while (text[n] === "`") n++;
      const ticks = n - i;
      const known = noCloser.get(ticks);
      let close = -1;
      if (known === undefined || n < known) {
        let from = n;
        // A closer is a run of exactly `ticks` backticks.
        for (;;) {
          const j = text.indexOf("`".repeat(ticks), from);
          if (j < 0) break;
          let e = j + ticks;
          if (text[e] !== "`" && text[j - 1] !== "`") {
            close = j;
            break;
          }
          while (text[e] === "`") e++;
          from = e;
        }
        if (close < 0) noCloser.set(ticks, n);
      }
      if (close >= 0) {
        let code = text.slice(n, close).replace(/\n/g, " ").split(CARET).join("");
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ")) code = code.slice(1, -1);
        push({ t: "code", text: code });
        i = close + ticks;
      } else {
        buf += text.slice(i, n);
        i = n;
      }
      continue;
    }
    if ((ch === "[" || (ch === "!" && text[i + 1] === "[")) && (m = match(LINK, text, i))) {
      const dest = (m[2] ?? m[3] ?? "").trim();
      if (ch === "!") {
        // Images are never fetched from the network (privacy + CSP): the renderer shows local
        // files through the app's own API and everything else as a chip.
        push({ t: "image", src: dest, alt: inlineText(inner(m[1], true)) });
      } else {
        push({ t: "link", href: safeHref(dest), children: inner(m[1] || dest, true), raw: dest });
      }
      i += m[0].length;
      continue;
    }
    if (ch === "<" && !inLink && (m = match(ANGLE_MAIL, text, i))) {
      push({ t: "link", href: "mailto:" + m[1], children: [m[1]] });
      i += m[0].length;
      continue;
    }
    if (ch === "&" && (m = (ENTITY.lastIndex = i, ENTITY.exec(text)))) {
      const decoded = decodeEntity(m);
      if (decoded !== null) {
        buf += decoded;
        i += m[0].length;
        continue;
      }
    }
    if (ch === "<" && (m = match(ANGLE_URL, text, i))) {
      const href = safeHref(m[1]);
      if (href) push({ t: "link", href, children: [m[1]] });
      else buf += m[0];
      i += m[0].length;
      continue;
    }
    if (ch === "w" && !inLink && !isWord(text[i - 1]) && text.startsWith("www.", i) && (m = match(BARE_WWW, text, i))) {
      const url = trimUrl(m[0]);
      const href = safeHref("http://" + url);
      if (href) {
        push({ t: "link", href, children: [url] });
        i += url.length;
        continue;
      }
    }
    if (hasAt && /[A-Za-z0-9]/.test(ch) && !/[\w.+%-]/.test(text[i - 1] ?? "") && (m = match(BARE_MAIL, text, i))) {
      push({ t: "link", href: "mailto:" + m[0], children: [m[0]] });
      i += m[0].length;
      continue;
    }
    if (ch === "h" && !inLink && !isWord(text[i - 1]) && (m = match(BARE_URL, text, i))) {
      const url = trimUrl(m[0]);
      const href = safeHref(url);
      if (href) {
        push({ t: "link", href, children: [url] });
        i += url.length;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      const under = ch === "_";
      const canOpen = !under || !isWord(text[i - 1]);
      const triple = canOpen && text.startsWith(under ? "___" : "***", i) ? match(under ? TRIPLE_UNDER : TRIPLE_STAR, text, i) : null;
      if (triple) {
        push({ t: "em", children: [{ t: "strong", children: inner(triple[1]) }] });
        i += triple[0].length;
        continue;
      }
      const strong = canOpen ? match(under ? STRONG_UNDER : STRONG_STAR, text, i) : null;
      if (strong) {
        push({ t: "strong", children: inner(strong[1]) });
        i += strong[0].length;
        continue;
      }
      const em = canOpen ? match(under ? EM_UNDER : EM_STAR, text, i) : null;
      if (em) {
        push({ t: "em", children: inner(em[1]) });
        i += em[0].length;
        continue;
      }
    }
    if (ch === "~" && (st = matchStrike(text, i, (closers ??= strikeClosers(text))))) {
      push({ t: "del", children: inner(st.body) });
      i += st.len;
      continue;
    }
    if (ch === "\n") {
      // Soft break (GFM): rendered as a space; two trailing spaces = hard break.
      if (buf.endsWith("  ")) {
        buf = buf.trimEnd();
        push({ t: "br" });
      } else buf += " ";
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Segmenting and caching (performance)

/**
 * Split a message into top-level chunks at blank lines that are outside code
 * fences and don't continue the block above: not before an indented line (a
 * list item's content, indented code), and not between the items of one list.
 * Each chunk parses on its own, so while a message streams only the last chunk
 * changes and needs re-parsing.
 */
export function splitSegments(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  let cur: string[] = [];
  let fence: Fence | null = null;
  let inList = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
      cur.push(line);
      continue;
    }
    if (line.trim()) {
      const open = line.length <= MAX_FORMATTED ? fenceOpen(line) : null;
      if (open) fence = open;
      if (line.length <= MAX_FORMATTED && listItem(line)) inList = true;
      else if (!(inList && /^\s/.test(line))) inList = false;
      cur.push(line);
      continue;
    }
    if (!cur.length) continue;
    // A run of blank lines: look at the first line after it.
    let k = i + 1;
    while (k < lines.length && !lines[k].trim()) k++;
    const next = lines[k];
    const continues =
      next !== undefined &&
      (/^[ \t]/.test(next) || (inList && next.length <= MAX_FORMATTED && listItem(next) !== null));
    if (continues) {
      for (let j = i; j < k; j++) cur.push(lines[j]);
    } else {
      out.push(cur.join("\n"));
      cur = [];
      inList = false;
    }
    i = k - 1;
  }
  if (cur.length) out.push(cur.join("\n"));
  return out.length ? out : [text];
}

/** Tiny LRU cache for parse results, keyed by the exact text. */
export class LruCache<V> {
  private map = new Map<string, V>();
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, v: V) {
    this.map.delete(key);
    this.map.set(key, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  get size() {
    return this.map.size;
  }
}

const blockCache = new LruCache<Block[]>(600);
const inlineCache = new LruCache<Inline[]>(3000);

export function parseBlocksCached(src: string): Block[] {
  let v = blockCache.get(src);
  if (!v) {
    v = parseBlocks(src);
    // The streaming caret makes every frame's text unique: don't cache those.
    if (!src.includes(CARET)) blockCache.set(src, v);
  }
  return v;
}

export function parseInlineCached(text: string): Inline[] {
  let v = inlineCache.get(text);
  if (!v) {
    v = parseInline(text);
    if (!text.includes(CARET)) inlineCache.set(text, v);
  }
  return v;
}

/**
 * The host to show next to a link whose text doesn't reveal where it goes
 * ("click here" → example.com), so a misleading label can't hide the target.
 * Null when the label already contains the host or the URL itself.
 */
export function linkHostHint(href: string, label: string): string | null {
  let host: string;
  try {
    const u = new URL(href);
    if (u.protocol === "mailto:") return null;
    host = u.host.replace(/^www\./, "");
  } catch {
    return null;
  }
  const l = label.trim().toLowerCase();
  if (!l) return null;
  // The host has to appear as whole labels ("github.com" doesn't vouch for "ithub.com", nor "evil-github.com").
  const h = host.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?:^|[^a-z0-9.-])(?:www\\.)?${h}(?:$|[^a-z0-9.-]|\\.(?![a-z0-9-]))`).test(l)) return null;
  return host;
}
