import { createContext, memo, useContext, useDeferredValue, useMemo, useRef, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageOff } from "lucide-react";
import { toast } from "sonner";
import { isExternalUrl, linkMismatchHost, openExternal } from "@/lib/external";
import { cn } from "@/lib/utils";
import { localImagePath } from "@/lib/images";
import { CopyButton } from "./CopyButton";
import { LocalImage } from "./LocalImage";
import { CodeText } from "./CodeText";
import { langFromFence } from "@/lib/highlight";
import { commandText, findHiddenChars, isShellLang, looksLikeCommand, revealHidden } from "@/lib/shellRun";
import { useApp } from "@/store/app";
import { RunButton } from "./RunButton";

/** Agent whose terminal shell code blocks can run in; null (default) hides the Run button. */
const RunContext = createContext<string | null>(null);

function CodeBlock({ lang, code }: { lang: string | null; code: string }) {
  const isDiff = lang === "diff" || lang === "patch";
  const lines = code.replace(/\n$/, "").split("\n");
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
    <div className="group/code my-3 overflow-hidden rounded-xl border border-line bg-code edge">
      <div className="flex h-8 items-center justify-between border-b border-line bg-panel/60 pl-3 pr-1.5">
        <span className="font-mono text-[11px] lowercase tracking-wide text-steel">{lang ?? "text"}</span>
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
        {...(command
          ? {
              tabIndex: 0,
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  runFn.current();
                }
              },
            }
          : {})}
        className="selectable overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-[1.6] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/50"
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

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const match = /language-([\w+-]+)/.exec(className ?? "");
    const text = textOf(children);
    const block = Boolean(match) || text.includes("\n");
    if (!block) return <code>{children}</code>;
    return <CodeBlock lang={match ? match[1] : null} code={text} />;
  },
  a: ({ href, children }) => (
    <a
      href={href}
      rel="noreferrer noopener"
      title={href}
      onClick={(e) => {
        e.preventDefault();
        if (!href) return;
        const host = linkMismatchHost(textOf(children), href);
        if (!host) return void openExternal(href);
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
        const local = agentId ? localImagePath(url) : null;
        if (local && agentId) return <LocalImage agentId={agentId} path={local} alt={alt ?? ""} />;
        return <RemoteImageChip url={url} alt={alt ?? ""} />;
      },
    }),
    [agentId],
  );
}

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
  // Under load React may skip intermediate frames of the growing tail.
  const deferred = useDeferredValue(text);
  const src = streaming ? deferred : text;
  const comps = useComponents(agentId);
  // Incremental while streaming: only the last block is re-scanned as text appends.
  const prev = useRef<{ text: string; ranges: BlockRange[] } | null>(null);
  const ranges = useMemo(() => {
    const p = prev.current;
    let next: BlockRange[];
    if (streaming && p && p.ranges.length > 0 && src.startsWith(p.text)) {
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
      <div className={cn("prose-armada selectable", streaming && "[&>*:last-child>*:last-child]:caret", className)}>
        {ranges.map((r, i) => (
          // Index keys are stable: blocks only ever append or grow at the end.
          <div key={i} className="md-block contents">
            <Block text={src.slice(r.start, r.end).replace(/\n+$/, "")} comps={comps} />
          </div>
        ))}
      </div>
    </RunContext.Provider>
  );
});
