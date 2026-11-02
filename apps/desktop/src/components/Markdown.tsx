import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  memo,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, ImageOff } from "lucide-react";
import { toast } from "sonner";
import {
  isExternalUrl,
  linkMismatchHost,
  loopbackLink,
  openExternal,
  openLink,
  PREVIEW_LINK_HINT,
  resolveAgentId,
} from "@/lib/external";
import { useThrottledValue } from "@/hooks/useThrottledValue";
import { cn } from "@/lib/utils";
import { inlineImageSrc } from "@/lib/inlineImage";
import { localImagePath } from "@/lib/images";
import { CopyButton } from "./CopyButton";
import { LocalImage } from "./LocalImage";
import { CodeText } from "./CodeText";
import { langFromFence } from "@/lib/highlight";
import { commandText, findHiddenChars, isShellLang, looksLikeCommand, revealHidden } from "@/lib/shellRun";
import { useApp } from "@/store/app";
import { RunButton } from "./RunButton";
import { CODE_PREVIEW_LINES, codeCollapses } from "./timeline/collapse";

/** Agent whose terminal shell code blocks can run in; null (default) hides the Run button. */
const RunContext = createContext<string | null>(null);

/** The message this text belongs to is still streaming (its code blocks stay open: they'd jump under the reader). */
const StreamingContext = createContext(false);

/** Height of a folded code block's visible part: the preview lines plus the block's vertical padding. */
const CODE_LINE_PX = 12.5 * 1.65;
const CODE_PREVIEW_PX = Math.round(CODE_PREVIEW_LINES * CODE_LINE_PX + 24);

function CodeBlock({ lang, code }: { lang: string | null; code: string }) {
  const isDiff = lang === "diff" || lang === "patch";
  const lines = code.replace(/\n$/, "").split("\n");
  const streaming = useContext(StreamingContext);
  // A block that grew while the reader watched stays open.
  const watched = useRef(false);
  if (streaming) watched.current = true;
  const foldable = !streaming && codeCollapses(lines.length, watched.current);
  const [open, setOpen] = useState(false);
  const folded = foldable && !open;
  const runAgent = useContext(RunContext);
  const platform = useApp((s) => s.platform);
  const shellish = useMemo(
    () => Boolean(runAgent) && (lang ? isShellLang(lang, platform) : looksLikeCommand(code)),
    [runAgent, lang, code, platform],
  );
  // Invisible or control characters would make the shown command differ from what runs.
  const hidden = useMemo(() => shellish && findHiddenChars(code).length > 0, [shellish, code]);
  const command = useMemo(() => (shellish && !hidden ? commandText(code, lang) : ""), [shellish, hidden, code, lang]);
  const shown = hidden ? revealHidden(code) : code;
  const runFn = useRef<() => void>(() => {});
  return (
    <div dir="ltr" className="group/code my-3 overflow-hidden rounded-xl border border-line bg-code">
      <div className="flex h-8 items-center justify-between border-b border-line/70 bg-panel/50 pl-3.5 pr-1.5">
        <span className="flex items-baseline gap-2">
          <span className="font-mono text-[11px] lowercase tracking-wide text-steel">{lang ?? "text"}</span>
          {lines.length > 12 && (
            <span className="text-[11px] tabular-nums text-steel">{lines.length.toLocaleString()} lines</span>
          )}
        </span>
        <div className="flex items-center gap-0.5">
          {runAgent && command && (
            <RunButton
              agentId={runAgent}
              command={command}
              runRef={(fn) => {
                runFn.current = fn;
              }}
            />
          )}
          <CopyButton text={shown} className="opacity-70 group-hover/code:opacity-100" />
        </div>
      </div>
      {hidden && (
        <div role="alert" className="border-b border-line bg-err/10 px-3.5 py-1.5 text-[12px] text-err">
          This command contains hidden characters and can't be run from here.
        </div>
      )}
      <pre
        // Focusable so the keyboard can scroll a wide block sideways (and run a command with Ctrl/⌘+Enter).
        tabIndex={0}
        {...(command
          ? {
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  runFn.current();
                }
              },
            }
          : {})}
        style={folded ? { maxHeight: CODE_PREVIEW_PX } : undefined}
        className={cn(
          "selectable overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-[1.65] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/50",
          folded && "overflow-y-hidden fold-fade-code",
        )}
        // Tabbing into a folded block opens it (the keyboard can't scroll a clipped one); clicking to select text doesn't.
        onFocusCapture={(e) => folded && e.currentTarget.matches(":focus-visible") && setOpen(true)}
      >
        <code>
          {isDiff ? (
            lines.map((l, i) => (
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
            <CodeText code={shown.replace(/\n$/, "")} lang={langFromFence(lang)} />
          )}
        </code>
      </pre>
      {foldable && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={!folded}
          className="flex h-8 w-full items-center justify-center gap-1.5 border-t border-line/70 text-[12px] text-steel transition-colors hover:bg-raised/40 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
        >
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-150", !folded && "rotate-180")} />
          {folded ? `Show all ${lines.length.toLocaleString()} lines` : "Show less"}
        </button>
      )}
    </div>
  );
}

function RemoteImageChip({ url, alt }: { url: string; alt: string }) {
  let label = url;
  try {
    const u = new URL(url);
    label = `${u.host}${u.pathname.length > 1 ? u.pathname : ""}`;
  } catch {
    /* keep raw */
  }
  const external = isExternalUrl(url);
  return (
    <button
      type="button"
      disabled={!external}
      title={external ? `Open ${url} in your browser` : "Image not shown"}
      onClick={() => external && void openExternal(url)}
      className="mx-0.5 inline-flex max-w-full items-center gap-1.5 rounded-md border border-line-strong bg-raised px-1.5 py-0.5 align-middle text-[12px] text-muted transition-colors hover:text-fg disabled:opacity-60"
    >
      <ImageOff className="h-3.5 w-3.5 shrink-0 text-steel" />
      <span className="truncate">
        Image{alt ? ` “${alt}”` : ""}: {label || "unavailable"}
      </span>
    </button>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return "";
}

/** The bits of a hast node that the table helpers read. */
interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
}

function hastText(n: HastNode): string {
  return n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(hastText).join("");
}

/** A number, optionally signed, with a currency sign, a percent sign or a short unit ("64.77", "-0.01", "182 ms", "12%"). */
const NUMERIC_CELL_RE = /^[~≈<>+\-−–]?\s*[$€£¥]?\s*\d[\d,._]*\s*(?:[%x×]|[a-zA-Zµ]{1,3}(?:\/\w+)?)?$/;

/** Columns whose body cells are all numbers (right-aligned with tabular figures). Empty cells and "-" are ignored. */
export function numericColumns(table: HastNode | undefined): boolean[] {
  const cols: (boolean | undefined)[] = [];
  const visit = (n: HastNode, inHead: boolean) => {
    if (n.tagName === "tr") {
      if (inHead) return;
      let i = 0;
      for (const cell of n.children ?? []) {
        if (cell.tagName !== "td" && cell.tagName !== "th") continue;
        const t = hastText(cell).trim();
        if (t && !/^[-–—]+$/.test(t)) cols[i] = (cols[i] ?? true) && NUMERIC_CELL_RE.test(t);
        i++;
      }
      return;
    }
    for (const c of n.children ?? []) visit(c, inHead || n.tagName === "thead");
  };
  if (table) visit(table, false);
  return Array.from(cols, (c) => c === true);
}

const NumericColumns = createContext<boolean[]>([]);

/** Table row that marks the cells of numeric columns. */
function NumericRow({ children }: { children?: ReactNode }) {
  const numeric = useContext(NumericColumns);
  let i = 0;
  return (
    <tr>
      {Children.map(children, (child) => {
        if (!isValidElement(child)) return child;
        const flag = numeric[i++];
        return flag ? cloneElement(child as ReactElement<Record<string, unknown>>, { "data-num": "" }) : child;
      })}
    </tr>
  );
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const match = /language-([\w+-]+)/.exec(className ?? "");
    const text = textOf(children);
    const block = Boolean(match) || text.includes("\n");
    if (!block) return <code>{children}</code>;
    return <CodeBlock lang={match ? match[1] : null} code={text} />;
  },
  table: ({ node, children }) => (
    <div className="md-table">
      <NumericColumns.Provider value={numericColumns(node as HastNode | undefined)}>
        <table>{children}</table>
      </NumericColumns.Provider>
    </div>
  ),
  tr: NumericRow,
  a: ({ href, children }) => (
    <a
      href={href}
      rel="noreferrer noopener"
      title={loopbackLink(href) ? PREVIEW_LINK_HINT : href}
      // Handled here, not by the document navigation guard (which would open it before the
      // mismatch check below could warn).
      data-own-click=""
      onClick={(e) => {
        e.preventDefault();
        if (!href) return;
        const host = linkMismatchHost(textOf(children), href);
        if (!host) return void openLink(href, e.nativeEvent, resolveAgentId(e.currentTarget));
        toast(`This link goes to ${host}`, {
          description: "The link text shows a different address.",
          action: { label: "Open", onClick: () => void openExternal(href) },
        });
      }}
    >
      {children}
    </a>
  ),
};

/** Keep local file paths (incl. file:// and Windows drive paths) for images; everything else uses the default filter. */
function urlTransform(url: string, key: string): string {
  if (key === "src" && (/^file:\/\//i.test(url) || /^[A-Za-z]:[\\/]/.test(url))) return url;
  if (key === "src" && inlineImageSrc(url)) return url;
  return defaultUrlTransform(url);
}

export interface BlockRange {
  start: number;
  end: number;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
const INDENTED_RE = /^(?: {4}|\t)/;

/**
 * Split markdown into top-level blocks at blank lines, so a streaming message only re-parses
 * its last (growing) block and finished blocks stay memoized. A blank line is NOT a boundary:
 * inside a fence (closed only by the same character, at least as long), before indented
 * content (list continuations, indented code), or between items of the same list.
 * Ranges are offsets into `text`, starting the scan at `from` (which must be a block start).
 */
export function splitBlockRanges(text: string, from = 0): BlockRange[] {
  const out: BlockRange[] = [];
  // Lines with their offsets.
  const lines: { start: number; text: string }[] = [];
  let pos = from;
  while (pos <= text.length) {
    const nl = text.indexOf("\n", pos);
    const end = nl < 0 ? text.length : nl;
    lines.push({ start: pos, text: text.slice(pos, end) });
    if (nl < 0) break;
    pos = nl + 1;
  }
  let fence: { char: string; len: number } | null = null;
  let blockStart = from;
  let blockHasContent = false;
  let inList = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].text;
    const m = FENCE_RE.exec(line);
    if (fence) {
      if (m && m[1][0] === fence.char && m[1].length >= fence.len && m[2].trim() === "") fence = null;
      continue;
    }
    if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
      fence = { char: m[1][0], len: m[1].length };
      blockHasContent = true;
      continue;
    }
    if (line.trim() !== "") {
      if (LIST_ITEM_RE.test(line)) inList = true;
      // Inside a list, any indented line is item content.
      else if (!(inList && /^\s/.test(line))) inList = false;
      blockHasContent = true;
      continue;
    }
    if (!blockHasContent) continue;
    // Blank line: look at the next non-blank line to decide.
    let k = i + 1;
    while (k < lines.length && lines[k].text.trim() === "") k++;
    const next = lines[k]?.text;
    if (next === undefined) continue; // trailing blank lines stay with the block
    if (INDENTED_RE.test(next)) continue; // continuation / indented code
    if (inList && (LIST_ITEM_RE.test(next) || /^\s+\S/.test(next))) continue; // loose list / item content
    out.push({ start: blockStart, end: lines[i].start });
    blockStart = lines[k].start;
    blockHasContent = false;
    inList = false;
    i = k - 1;
  }
  if (blockStart < text.length || out.length === 0) out.push({ start: blockStart, end: text.length });
  return out;
}

/**
 * Link reference definitions (`[1]: https://…`) and footnotes (`[^1]: …`) are resolved across the whole
 * document, so a text that has them can't be parsed block by block (`[docs][1]` would stay literal).
 */
const DEFINITION_RE = /^ {0,3}\[[^\]\n]+\]:[ \t]*\S/m;

export function hasDefinitions(text: string): boolean {
  return DEFINITION_RE.test(text);
}

/** Block texts (see splitBlockRanges). */
export function splitBlocks(text: string): string[] {
  return splitBlockRanges(text).map((r) => text.slice(r.start, r.end).replace(/\n+$/, ""));
}

function useComponents(agentId: string | undefined): Components {
  return useMemo<Components>(
    () => ({
      ...components,
      // Never fetch remote images from agent output (a prompt-injected agent could
      // exfiltrate data through the URL). Local files load through the backend.
      img: ({ src, alt }) => {
        const url = typeof src === "string" ? src : "";
        const inline = inlineImageSrc(url);
        if (inline)
          return (
            <img
              src={inline}
              alt={alt ?? ""}
              loading="lazy"
              decoding="async"
              className="my-1 block max-h-[28rem] max-w-full rounded-lg border border-line object-contain"
            />
          );
        const local = agentId ? localImagePath(url) : null;
        if (local && agentId) return <LocalImage agentId={agentId} path={local} alt={alt ?? ""} />;
        return <RemoteImageChip url={url} alt={alt ?? ""} />;
      },
    }),
    [agentId],
  );
}

/** How often the streaming tail is re-parsed. */
const STREAM_PARSE_MS = 100;

/** One parsed block; memoized on its text so finished blocks never re-parse. */
const Block = memo(function Block({ text, comps }: { text: string; comps: Components }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={comps} urlTransform={urlTransform}>
      {text}
    </ReactMarkdown>
  );
});

export const Markdown = memo(function Markdown({
  text,
  className,
  streaming,
  agentId,
  runAgentId,
}: {
  text: string;
  className?: string;
  streaming?: boolean;
  /** Enables inline images for files in this agent's folders (loaded via readImage). */
  agentId?: string;
  /** Shows a Run button on shell code blocks that runs them in this agent's workspace terminal. */
  runAgentId?: string;
}) {
  // The growing tail is re-parsed on every change, so refresh it at ~10 Hz instead of per delta.
  const src = useThrottledValue(text, STREAM_PARSE_MS, !!streaming);
  const comps = useComponents(agentId);
  // Incremental while streaming: only the last block is re-scanned as text appends.
  const prev = useRef<{ text: string; ranges: BlockRange[] } | null>(null);
  const ranges = useMemo(() => {
    const p = prev.current;
    let next: BlockRange[];
    if (hasDefinitions(src)) {
      next = [{ start: 0, end: src.length }];
    } else if (streaming && p && p.ranges.length > 0 && src.startsWith(p.text)) {
      const last = p.ranges[p.ranges.length - 1];
      next = [...p.ranges.slice(0, -1), ...splitBlockRanges(src, last.start)];
    } else {
      next = splitBlockRanges(src);
    }
    prev.current = { text: src, ranges: next };
    return next;
  }, [src, streaming]);
  // The same block structure is rendered while streaming and after, so finishing a stream
  // doesn't remount (and re-parse) the whole message: unchanged blocks keep their memo.
  return (
    <RunContext.Provider value={runAgentId && !streaming ? runAgentId : null}>
      <StreamingContext.Provider value={!!streaming}>
        <div className={cn("prose-kvistcode selectable", streaming && "[&>*:last-child>*:last-child]:caret", className)}>
          {ranges.map((r, i) => (
            // Index keys are stable: blocks only ever append or grow at the end.
            // dir="auto": a block that starts in Arabic or Hebrew reads right to left (code stays left to right).
            <div key={i} dir="auto" className="md-block contents">
              <Block text={src.slice(r.start, r.end).replace(/\n+$/, "")} comps={comps} />
            </div>
          ))}
        </div>
      </StreamingContext.Provider>
    </RunContext.Provider>
  );
});
