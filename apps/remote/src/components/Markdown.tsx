/**
 * Renders the AST from `lib/markdown.ts` as React elements. Untrusted text is
 * only ever placed in text nodes and sanitized `href`s, never parsed as HTML.
 */
import { memo, useMemo, type ReactNode } from "react";
import { CARET, parseBlocksCached, parseInlineCached, splitSegments, type Block, type Inline } from "@/lib/markdown";
import { linkHostHint } from "@/lib/markdown";
import { isLocalImagePath } from "@/lib/localImages";
import { CopyButton } from "./CopyButton";
import { LocalImage } from "./LocalImage";

function Caret() {
  return <span className="md-caret" aria-hidden />;
}

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    if (typeof n === "string") return n;
    switch (n.t) {
      case "code":
        return (
          <code key={i} className="md-code">
            {n.text}
          </code>
        );
      case "link": {
        if (!n.href && n.raw && isLocalImagePath(n.raw)) return <LocalImage key={i} path={n.raw} alt={plainText(n.children)} />;
        if (!n.href)
          return (
            <span key={i} className="md-badlink">
              {renderInline(n.children)}
            </span>
          );
        const host = linkHostHint(n.href, plainText(n.children));
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow" className="md-link">
            {renderInline(n.children)}
            {host && <span className="md-host"> ({host})</span>}
          </a>
        );
      }
      case "strong":
        return <strong key={i}>{renderInline(n.children)}</strong>;
      case "em":
        return <em key={i}>{renderInline(n.children)}</em>;
      case "del":
        return <del key={i}>{renderInline(n.children)}</del>;
      case "br":
        return <br key={i} />;
      case "caret":
        return <Caret key={i} />;
    }
  });
}

function plainText(nodes: Inline[]): string {
  return nodes.map((n) => (typeof n === "string" ? n : "children" in n ? plainText(n.children) : n.t === "code" ? n.text : "")).join("");
}

const inline = (text: string) => renderInline(parseInlineCached(text));

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

function PlainText({ text }: { text: string }) {
  const caret = text.includes(CARET);
  return (
    <p className="whitespace-pre-wrap">
      {caret ? text.split(CARET).join("") : text}
      {caret && <Caret />}
    </p>
  );
}

function renderBlocks(blocks: Block[], tight = false): ReactNode[] {
  return blocks.map((b, i) => {
    switch (b.t) {
      case "p":
        if (b.plain) return <PlainText key={i} text={b.text} />;
        return tight ? (
          <span key={i} className="block">
            {inline(b.text)}
          </span>
        ) : (
          <p key={i}>{inline(b.text)}</p>
        );
      case "h": {
        const content = inline(b.text);
        if (b.level <= 1)
          return (
            <h3 key={i} className="md-h1">
              {content}
            </h3>
          );
        if (b.level === 2)
          return (
            <h4 key={i} className="md-h2">
              {content}
            </h4>
          );
        return (
          <h5 key={i} className="md-h3">
            {content}
          </h5>
        );
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
                      {inline(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {b.head.map((_, k) => (
                      <td key={k} style={{ textAlign: b.align[k] ?? undefined }}>
                        {inline(r[k] ?? "")}
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

/** One top-level chunk of a message; memoised so unchanged chunks never re-render. */
const Segment = memo(function Segment({ text }: { text: string }) {
  return <>{renderBlocks(parseBlocksCached(text))}</>;
});

/**
 * A message, rendered as independent segments (see `splitSegments`): while it
 * streams, only the last segment changes, so earlier paragraphs, code blocks
 * and tables are neither re-parsed nor re-rendered.
 */
export const Markdown = memo(function Markdown({ text, caret = false, className }: { text: string; caret?: boolean; className?: string }) {
  const segments = useMemo(() => splitSegments(caret ? text + CARET : text), [text, caret]);
  return (
    <div className={`md ${className ?? ""}`}>
      {segments.map((seg, i) => (
        <Segment key={i} text={seg} />
      ))}
    </div>
  );
});
