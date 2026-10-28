/**
 * Markdown parser for agent messages, producing a small AST that
 * `components/Markdown.tsx` renders as React elements (never HTML strings).
 *
 * Supported: ATX headings, paragraphs, bold/italic/strike, inline code,
 * fenced code blocks (also unterminated ones, while streaming), ordered and
 * unordered lists with nesting, block quotes, rules, GFM tables, links and
 * bare URLs. Only http(s)/mailto links are ever produced.
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
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "quote"; blocks: Block[] }
  | { t: "hr" }
  | { t: "table"; head: string[]; align: Align[]; rows: string[][] };

export type Inline =
  | string
  | { t: "code"; text: string }
  | { t: "link"; href: string | null; children: Inline[]; raw?: string; image?: boolean }
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

export function parseBlocks(src: string, depth = 0): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
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
      while (i < lines.length && lines[i].trim() && (quoteBody(lines[i]) !== null || !startsBlock(lines[i]))) {
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
      const items: { ci: number; lines: string[] }[] = [];
      let blankRun = false;
      while (i < lines.length) {
        const l = lines[i];
        const li = listItem(l);
        if (li && li.indent <= baseIndent + 1 && /\d/.test(li.marker) === ordered) {
          items.push({ ci: li.ci, lines: [" ".repeat(li.ci) + li.text] });
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
          if (blankRun) cur.lines.push("");
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
      blocks.push({
        t: "list",
        ordered,
        start,
        items: items.map(({ ci, lines: raw }) => {
          const body = raw.map((l) => l.slice(Math.min(ci, leadingSpaces(l)))).join("\n");
          return depth < MAX_DEPTH ? parseBlocks(body, depth + 1) : [{ t: "p", text: body }];
        }),
      });
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

    const para: string[] = [];
    let size = 0;
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines[i]))) {
      if (para.length && lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) break;
      if (para.length && lines[i].length > MAX_FORMATTED) break;
      para.push(lines[i].trim());
      size += lines[i].length;
      i++;
    }
    blocks.push({ t: "p", text: para.join("\n"), plain: size > MAX_FORMATTED || undefined });
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

const ESCAPE = /\\([\\`*_{}[\]()#+\-.!|~>])/y;
// URL part allows one level of balanced parentheses, e.g. Wikipedia-style links.
const LINK = /!?\[((?:[^[\]\\]|\\.|\[[^\]]*\])*)\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))*)>?(?:\s+["'][^"']*["'])?\s*\)/y;
const ANGLE_URL = /<((?:https?:\/\/|mailto:)[^\s>]+)>/y;
const BARE_URL = /https?:\/\/[^\s<>"']+/y;
const STRONG_STAR = /\*\*(?=\S)([\s\S]*?\S)\*\*/y;
const STRONG_UNDER = /__(?=\S)([\s\S]*?\S)__(?!\w)/y;
const EM_STAR = /\*(?=[^\s*])([\s\S]*?[^\s*\\])\*(?!\*)/y;
const EM_UNDER = /_(?=[^\s_])([\s\S]*?[^\s_\\])_(?!\w)/y;
const STRIKE = /~~(?=\S)([\s\S]*?\S)~~/y;

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

export function parseInline(text: string, depth = 0): Inline[] {
  if (text.length > MAX_FORMATTED) return [text.split(CARET).join(""), ...(text.includes(CARET) ? [{ t: "caret" } as const] : [])];
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push(buf);
    buf = "";
  };
  const push = (node: Inline) => {
    flush();
    out.push(node);
  };
  const inner = (s: string) => (depth < MAX_DEPTH ? parseInline(s, depth + 1) : [s]);
  // For each backtick-run length, the position from which no closing run exists.
  const noCloser = new Map<number, number>();

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    let m: RegExpExecArray | null;

    if (ch === CARET) {
      push({ t: "caret" });
      i++;
      continue;
    }
    if (ch === "\\") {
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
      const label = m[1] || m[2];
      // Images are never loaded (privacy + CSP); their alt text becomes a link.
      push({ t: "link", href: safeHref(m[2]), children: inner(label), raw: m[2], image: ch === "!" });
      i += m[0].length;
      continue;
    }
    if (ch === "<" && (m = match(ANGLE_URL, text, i))) {
      const href = safeHref(m[1]);
      if (href) push({ t: "link", href, children: [m[1]] });
      else buf += m[0];
      i += m[0].length;
      continue;
    }
    if (ch === "h" && !isWord(text[i - 1]) && (m = match(BARE_URL, text, i))) {
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
    if (ch === "~" && text[i + 1] === "~" && (m = match(STRIKE, text, i))) {
      push({ t: "del", children: inner(m[1]) });
      i += m[0].length;
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
 * fences and not followed by an indented (continuation) line. Each chunk
 * parses on its own, so while a message streams only the last chunk changes
 * and needs re-parsing.
 */
export function splitSegments(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  let cur: string[] = [];
  let fence: Fence | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
      cur.push(line);
      continue;
    }
    const open = line.length <= MAX_FORMATTED ? fenceOpen(line) : null;
    if (open) fence = open;
    if (!line.trim() && cur.length) {
      const next = lines[i + 1];
      const continuation = next !== undefined && next.trim() !== "" && /^[ \t]/.test(next);
      if (!continuation) {
        out.push(cur.join("\n"));
        cur = [];
        continue;
      }
    }
    cur.push(line);
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
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
  if (!l || l.includes(host.toLowerCase())) return null;
  return host;
}
