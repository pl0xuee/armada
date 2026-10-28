/**
 * Small markdown renderer for agent messages. It builds React elements
 * directly (never HTML strings), so untrusted text can't inject markup, and
 * only http(s)/mailto links become clickable.
 *
 * Supported: ATX headings, paragraphs, bold/italic/strike, inline code,
 * fenced code blocks (also unterminated ones, while streaming), ordered and
 * unordered lists with nesting, block quotes, rules, GFM tables, links and
 * bare URLs.
 */
import { memo, useMemo, type ReactNode } from "react";
import { CopyButton } from "./CopyButton";

type Align = "left" | "center" | "right" | null;

type Block =
  | { t: "p"; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "code"; lang: string; text: string }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "quote"; blocks: Block[] }
  | { t: "hr" }
  | { t: "table"; head: string[]; align: Align[]; rows: string[][] };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const MAX_DEPTH = 6;

/** Private-use sentinel appended while streaming; rendered as a blinking caret wherever the text ends. */
const CARET = "\uE000";

function Caret() {
  return <span className="md-caret" aria-hidden />;
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
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);
}

function indentOf(line: string): number {
  const m = /^ */.exec(line);
  return m ? m[0].length : 0;
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

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      // Closed by a run of the same character at least as long as the opener.
      const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
      const indent = indentOf(line);
      const strip = new RegExp(`^ {0,${indent}}`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) {
        body.push(indent ? lines[i].replace(strip, "") : lines[i]);
        i++;
      }
      i++; // closing fence (or past the end while a message is still streaming)
      blocks.push({ t: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ t: "h", level: heading[1].length, text: heading[2] ?? "" });
      i++;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !startsBlock(lines[i]))) {
        const m = QUOTE.exec(lines[i]);
        body.push(m ? m[1] : lines[i]);
        i++;
      }
      blocks.push({ t: "quote", blocks: depth < MAX_DEPTH ? parseBlocks(body.join("\n"), depth + 1) : [{ t: "p", text: body.join("\n") }] });
      continue;
    }

    const li = LIST_ITEM.exec(line);
    if (li) {
      const baseIndent = li[1].length;
      const ordered = /\d/.test(li[2]);
      const start = ordered ? parseInt(li[2], 10) : 1;
      const items: { ci: number; lines: string[] }[] = [];
      let blankRun = false;
      while (i < lines.length) {
        const l = lines[i];
        const m = LIST_ITEM.exec(l);
        if (m && m[1].length <= baseIndent + 1 && /\d/.test(m[2]) === ordered) {
          const ci = m[1].length + m[2].length + Math.min(m[3].length || 1, 4);
          items.push({ ci, lines: [" ".repeat(ci) + m[4]] });
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
        if (indentOf(l) >= Math.min(cur.ci, baseIndent + 2)) {
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
          const body = raw.map((l) => l.slice(Math.min(ci, indentOf(l)))).join("\n");
          return depth < MAX_DEPTH ? parseBlocks(body, depth + 1) : [{ t: "p", text: body }];
        }),
      });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
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
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines[i]))) {
      if (para.length && lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) break;
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ t: "p", text: para.join("\n") });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Inline

export function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (/^(https?:|mailto:)/i.test(url)) {
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? u.href : null;
    } catch {
      return null;
    }
  }
  return null;
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

function match(re: RegExp, text: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(text);
}

/** Trim punctuation that is almost never part of a bare URL. */
function trimUrl(url: string): string {
  let u = url.replace(/[.,;:!?*_~]+$/, "");
  while (u.endsWith(")") && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) u = u.slice(0, -1);
  return u;
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="md-link">
      {children}
    </a>
  );
}

export function renderInline(text: string, depth = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = "";
  let key = 0;
  const flush = () => {
    if (buf) out.push(buf);
    buf = "";
  };
  const push = (node: ReactNode) => {
    flush();
    out.push(<InlineKey key={key++}>{node}</InlineKey>);
  };
  const inner = (s: string) => (depth < MAX_DEPTH ? renderInline(s, depth + 1) : [s]);

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    let m: RegExpExecArray | null;

    if (ch === CARET) {
      push(<Caret />);
      i++;
      continue;
    }
    if (ch === "\\" && (m = match(ESCAPE, text, i))) {
      buf += m[1];
      i += m[0].length;
      continue;
    }
    if (ch === "`") {
      const run = /`+/y;
      run.lastIndex = i;
      const ticks = run.exec(text)![0];
      const close = text.indexOf(ticks, i + ticks.length);
      if (close > 0) {
        let code = text.slice(i + ticks.length, close).replace(/\n/g, " ");
        if (/^ .* $/.test(code)) code = code.slice(1, -1);
        push(<code className="md-code">{code}</code>);
        i = close + ticks.length;
        continue;
      }
      buf += ticks;
      i += ticks.length;
      continue;
    }
    if ((ch === "[" || (ch === "!" && text[i + 1] === "[")) && (m = match(LINK, text, i))) {
      const label = m[1] || m[2];
      const href = safeHref(m[2]);
      // Images are never loaded (privacy + CSP); show their alt text as a link.
      push(href ? <ExternalLink href={href}>{inner(label)}</ExternalLink> : <span className="md-badlink">{inner(label)}</span>);
      i += m[0].length;
      continue;
    }
    if (ch === "<" && (m = match(ANGLE_URL, text, i))) {
      const href = safeHref(m[1]);
      push(href ? <ExternalLink href={href}>{m[1]}</ExternalLink> : m[0]);
      i += m[0].length;
      continue;
    }
    if (ch === "h" && !/\w/.test(text[i - 1] ?? "") && (m = match(BARE_URL, text, i))) {
      const url = trimUrl(m[0]);
      const href = safeHref(url);
      if (href) {
        push(<ExternalLink href={href}>{url}</ExternalLink>);
        i += url.length;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      const strong = ch === "*" ? match(STRONG_STAR, text, i) : !/\w/.test(text[i - 1] ?? "") ? match(STRONG_UNDER, text, i) : null;
      if (strong) {
        push(<strong>{inner(strong[1])}</strong>);
        i += strong[0].length;
        continue;
      }
      const em = ch === "*" ? match(EM_STAR, text, i) : !/\w/.test(text[i - 1] ?? "") ? match(EM_UNDER, text, i) : null;
      if (em) {
        push(<em>{inner(em[1])}</em>);
        i += em[0].length;
        continue;
      }
    }
    if (ch === "~" && (m = match(STRIKE, text, i))) {
      push(<del>{inner(m[1])}</del>);
      i += m[0].length;
      continue;
    }
    if (ch === "\n") {
      // Soft break (GFM): rendered as a space; two trailing spaces = hard break.
      if (buf.endsWith("  ")) {
        buf = buf.trimEnd();
        push(<br />);
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

function InlineKey({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// Blocks

function CodeBlock({ lang, text: raw }: { lang: string; text: string }) {
  const caret = raw.includes(CARET);
  const text = caret ? raw.split(CARET).join("") : raw;
  return (
    <div className="md-pre group">
      <div className="flex h-8 items-center justify-between border-b border-line/70 pr-1 pl-3">
        <span className="font-mono text-[11px] text-steel">{lang || "code"}</span>
        <CopyButton text={text} label="Copy code" />
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12.5px] leading-[1.55] text-fg">
        <code>{text}</code>
        {caret && <Caret />}
      </pre>
    </div>
  );
}

function renderBlocks(blocks: Block[], tight = false): ReactNode[] {
  return blocks.map((b, i) => {
    switch (b.t) {
      case "p":
        return tight ? (
          <span key={i} className="block">
            {renderInline(b.text)}
          </span>
        ) : (
          <p key={i}>{renderInline(b.text)}</p>
        );
      case "h": {
        const cls = b.level <= 1 ? "md-h1" : b.level === 2 ? "md-h2" : "md-h3";
        const content = renderInline(b.text);
        if (b.level <= 1) return <h3 key={i} className={cls}>{content}</h3>;
        if (b.level === 2) return <h4 key={i} className={cls}>{content}</h4>;
        return <h5 key={i} className={cls}>{content}</h5>;
      }
      case "code":
        return <CodeBlock key={i} lang={b.lang} text={b.text} />;
      case "hr":
        return <hr key={i} className="md-hr" />;
      case "quote":
        return (
          <blockquote key={i} className="md-quote">
            {renderBlocks(b.blocks)}
          </blockquote>
        );
      case "list": {
        const isTight = b.items.every((it) => it.length <= 1 || it.slice(1).every((x) => x.t === "list"));
        const children = b.items.map((it, j) => <li key={j}>{renderBlocks(it, isTight)}</li>);
        return b.ordered ? (
          <ol key={i} className="md-ol" start={b.start !== 1 ? b.start : undefined}>
            {children}
          </ol>
        ) : (
          <ul key={i} className="md-ul">
            {children}
          </ul>
        );
      }
      case "table":
        return (
          <div key={i} className="md-table-wrap">
            <table className="md-table">
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j} style={{ textAlign: b.align[j] ?? undefined }}>
                      {renderInline(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {b.head.map((_, k) => (
                      <td key={k} style={{ textAlign: b.align[k] ?? undefined }}>
                        {renderInline(r[k] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

export const Markdown = memo(function Markdown({ text, caret = false, className }: { text: string; caret?: boolean; className?: string }) {
  const nodes = useMemo(() => renderBlocks(parseBlocks(caret ? text + CARET : text)), [text, caret]);
  return <div className={`md ${className ?? ""}`}>{nodes}</div>;
});
