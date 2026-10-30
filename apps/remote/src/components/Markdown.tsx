/**
 * Renders the AST from `lib/markdown.ts` as React elements. Untrusted text is
 * only ever placed in text nodes and sanitized `href`s, never parsed as HTML.
 */
import { memo, useMemo, type ReactNode } from "react";
import { CARET, inlineText, linkHostHint, parseBlocksCached, parseInlineCached, safeHref, splitSegments, type Block, type Inline } from "@/lib/markdown";
import { highlight } from "@/lib/highlight";
import { markdownImagePath } from "@/lib/localImages";
import { cn } from "@/lib/cn";
import { CopyButton } from "./CopyButton";
import { Icon } from "./Icon";
import { LocalImage } from "./LocalImage";

function Caret() {
  return <span className="md-caret" aria-hidden />;
}

/** A web image reference: never fetched (privacy + CSP), shown like the desktop app's "Image: host/path" chip. */
function RemoteImageChip({ url, alt, plain }: { url: string; alt: string; plain: boolean }) {
  let label = "";
  if (!/^data:/i.test(url)) {
    label = url;
    try {
      const u = new URL(url);
      label = `${u.host}${u.pathname.length > 1 ? u.pathname : ""}`;
    } catch {
      /* keep the raw text */
    }
  }
  const href = plain ? null : safeHref(url);
  const cls = "md-imgchip";
  const body = (
    <>
      <Icon name="image" size={14} className="shrink-0 text-steel" />
      <span className="min-w-0 truncate">
        Image{alt ? ` \u201c${alt}\u201d` : ""}: {label || "unavailable"}
      </span>
    </>
  );
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={cls}>
      {body}
    </a>
  ) : (
    <span className={cls}>{body}</span>
  );
}

function renderInline(nodes: Inline[], inLink = false): ReactNode[] {
  return nodes.map((n, i) => {
    if (typeof n === "string") return n;
    switch (n.t) {
      case "code":
        return (
          <code key={i} className="md-code">
            {n.text}
          </code>
        );
      case "image": {
        const path = markdownImagePath(n.src);
        if (path) return <LocalImage key={i} path={path} alt={n.alt} />;
        return <RemoteImageChip key={i} url={n.src} alt={n.alt} plain={inLink} />;
      }
      case "link": {
        if (!n.href)
          return (
            <span key={i} className="md-badlink">
              {renderInline(n.children, true)}
            </span>
          );
        const host = linkHostHint(n.href, inlineText(n.children));
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow" className="md-link">
            {renderInline(n.children, true)}
            {host && <span className="md-host"> ({host})</span>}
          </a>
        );
      }
      case "strong":
        return <strong key={i}>{renderInline(n.children, inLink)}</strong>;
      case "em":
        return <em key={i}>{renderInline(n.children, inLink)}</em>;
      case "del":
        return <del key={i}>{renderInline(n.children, inLink)}</del>;
      case "br":
        return <br key={i} />;
      case "caret":
        return <Caret key={i} />;
    }
  });
}

const inline = (text: string) => renderInline(parseInlineCached(text));

/** Highlighted tokens as text nodes and class-only spans (the CSP forbids inline styles). */
function Tokens({ code, lang }: { code: string; lang: string }) {
  const toks = useMemo(() => highlight(code, lang), [code, lang]);
  if (!toks) return <>{code}</>;
  return (
    <>
      {toks.map((t, i) =>
        typeof t === "string" ? (
          t
        ) : (
          <span key={i} className={`tk-${t.c}`}>
            {t.t}
          </span>
        ),
      )}
    </>
  );
}

function CodeBlock({ lang, text: raw }: { lang: string; text: string }) {
  const caret = raw.includes(CARET);
  const text = caret ? raw.split(CARET).join("") : raw;
  // Only the language word of the info string ("rust,ignore" -> "rust"), as on the desktop.
  const name = /^[\w+-]+/.exec(lang)?.[0] ?? "";
  const diff = name === "diff" || name === "patch";
  return (
    <div className="md-pre group">
      <div className="flex h-8 items-center justify-between border-b border-line/70 bg-panel/50 pr-1 pl-3.5">
        <span className="font-mono text-[11px] tracking-wide text-steel/90 lowercase">{name || "text"}</span>
        <CopyButton text={text} label="Copy code" />
      </div>
      <pre className="overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-[1.65] text-fg">
        <code>
          {diff ? (
            text.split("\n").map((l, i) => (
              <span
                key={i}
                className={cn(
                  "-mx-3.5 block px-3.5",
                  l.startsWith("+") && "bg-[var(--diff-add)] text-ok",
                  l.startsWith("-") && "bg-[var(--diff-del)] text-err",
                  l.startsWith("@@") && "text-accent/80",
                )}
              >
                {l || " "}
              </span>
            ))
          ) : (
            <Tokens code={text} lang={name} />
          )}
        </code>
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

/** Cells longer than this wrap (with a minimum width); shorter ones stay on one line so narrow columns don't squash. */
const WRAP_CELL = 28;

function renderBlocks(blocks: Block[], tight = false, lead?: ReactNode): ReactNode[] {
  return blocks.map((b, i) => {
    // A task list's checkbox goes at the start of the item's first paragraph (as on the desktop).
    const prefix = i === 0 ? lead : null;
    switch (b.t) {
      case "p":
        if (b.plain) return <PlainText key={i} text={b.text} />;
        return tight ? (
          <span key={i} className="block">
            {prefix}
            {inline(b.text)}
          </span>
        ) : (
          <p key={i}>
            {prefix}
            {inline(b.text)}
          </p>
        );
      case "h": {
        const Tag = `h${b.level}` as "h1";
        return (
          <Tag key={i} className={`md-h md-h${Math.min(b.level, 4)}`}>
            {inline(b.text)}
          </Tag>
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
        const children = b.items.map((it, j) => {
          const task = b.checked?.[j];
          const box = task == null ? undefined : <input type="checkbox" checked={task} disabled aria-label={task ? "Done" : "Not done"} className="md-check" />;
          // The checkbox needs a paragraph to sit in; an item without one gets it on its own line.
          const lead = box && it[0]?.t === "p" && !it[0].plain ? box : undefined;
          return (
            <li key={j}>
              {box && !lead && box}
              {renderBlocks(it, !b.loose, lead)}
            </li>
          );
        });
        return b.ordered ? (
          <ol key={i} className="md-ol" start={b.start !== 1 ? b.start : undefined}>
            {children}
          </ol>
        ) : (
          <ul key={i} className={cn("md-ul", b.checked && "md-tasks")}>
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
                      <td key={k} className={(r[k]?.length ?? 0) > WRAP_CELL ? "md-wrap" : undefined} style={{ textAlign: b.align[k] ?? undefined }}>
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
export const Markdown = memo(function Markdown({
  text,
  caret = false,
  interim = false,
  className,
}: {
  text: string;
  caret?: boolean;
  /** Narration between tool calls (not the turn's final answer): a softer color, like the desktop app. */
  interim?: boolean;
  className?: string;
}) {
  const segments = useMemo(() => splitSegments(caret ? text + CARET : text), [text, caret]);
  return (
    <div className={cn("md", interim && "md-interim", className)}>
      {segments.map((seg, i) => (
        <Segment key={i} text={seg} />
      ))}
    </div>
  );
});
