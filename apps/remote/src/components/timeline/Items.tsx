import { memo, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { devParam } from "@/lib/dev";
import { cheapStatsAll } from "@/lib/diffStats";
import { clockTime, formatBytes, shortPath, wordCount } from "@/lib/format";
import { noteUserLayoutChange } from "@/lib/scroll";
import { cleanTerminalOutput, exitCodeOf } from "@/lib/terminal";
import type { Attachment, PlanEntry, TimelineItem, ToolCallItem, ToolKind, ToolStatus } from "@/lib/types";
import { CopyButton } from "../CopyButton";
import { Icon, Spinner, type IconName } from "../Icon";
import { ImageStrip } from "../Images";
import { LocalImage } from "../LocalImage";
import { isLocalImagePath } from "@/lib/localImages";
import { Markdown } from "../Markdown";
import { DiffList } from "./DiffView";

type Of<K extends TimelineItem["kind"]> = Extract<TimelineItem, { kind: K }>;

const EXPAND_ALL = devParam("expand") === "1";

export const TOOL_ICON: Record<ToolKind, IconName> = {
  read: "file",
  edit: "pencil",
  delete: "trash",
  move: "move",
  search: "search",
  execute: "terminal",
  think: "sparkle",
  fetch: "globe",
  other: "wrench",
};

function toggle(set: (fn: (v: boolean) => boolean) => void) {
  noteUserLayoutChange();
  set((v) => !v);
}

// ---------------------------------------------------------------------------

const LONG_USER_LINES = 14;

export const UserBubble = memo(function UserBubble({
  text,
  ts,
  attachments,
  state,
  progress = null,
  onRetry,
  onEdit,
}: {
  text: string;
  ts?: number;
  attachments?: Attachment[];
  /** Upload progress (0..1) while photos are sent. */
  progress?: number | null;
  state?: "sending" | "failed";
  onRetry?: () => void;
  onEdit?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = text.split("\n").length > LONG_USER_LINES || text.length > 900;
  return (
    <div className="flex flex-col items-end">
      {attachments && attachments.length > 0 && <ImageStrip images={attachments} className="mb-1.5 max-w-[86%] justify-end" />}
      {text.trim() !== "" && (
      <div
        className={cn(
          "relative max-w-[86%] rounded-[20px] rounded-br-md border px-3.5 py-2.5 text-[15px] leading-[1.5] break-words whitespace-pre-wrap",
          state === "failed" ? "border-err/40 bg-err/8" : "border-white/[0.06] bg-gunmetal",
          state === "sending" && "opacity-70",
        )}
        title={ts ? clockTime(ts) : undefined}
      >
        <div className={cn(long && !expanded && "max-h-[19.5em] overflow-hidden [mask-image:linear-gradient(180deg,#000_75%,transparent)]")}>{text}</div>
        {long && (
          <button
            type="button"
            onClick={() => toggle(setExpanded)}
            className="press hit relative mt-1 -mb-1 h-8 text-[13px] font-semibold text-accent"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>
      )}
      {state === "sending" &&
        (progress !== null && progress < 1 ? (
          <span className="mt-1.5 mr-1 flex w-40 flex-col items-end gap-1 text-[11.5px] text-steel" role="status">
            Uploading photos… {Math.round(progress * 100)}%
            <span className="h-1 w-full overflow-hidden rounded-full bg-raised" aria-hidden>
              <span className="block h-full w-full origin-left rounded-full bg-accent transition-transform duration-150" style={{ transform: `scaleX(${progress})` }} />
            </span>
          </span>
        ) : (
          <span className="mt-1 mr-1 text-[11.5px] text-steel">Sending…</span>
        ))}

      {state === "failed" && (
        <div className="mt-1 flex items-center gap-1 text-[12.5px]">
          <span className="inline-flex items-center gap-1 text-err">
            <Icon name="alertCircle" size={14} /> Not delivered
          </span>
          {onEdit && (
            <button type="button" onClick={onEdit} className="press hit relative h-9 rounded-lg px-2 font-semibold text-muted">
              Edit
            </button>
          )}
          {onRetry && (
            <button type="button" onClick={onRetry} className="press hit relative h-9 rounded-lg px-2 font-semibold text-accent">
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
});

export const AgentMessage = memo(function AgentMessage({
  item,
  streaming,
  interim = false,
}: {
  item: Of<"agent_message">;
  streaming: boolean;
  /** Narration between tool calls (not the turn's final answer). */
  interim?: boolean;
}) {
  const images = item.images ?? [];
  if (!item.text && !images.length) {
    if (streaming) return <TypingDots />;
    return <p className="text-[12.5px] text-steel italic">No reply (the turn ended before any text).</p>;
  }
  return (
    <div className="min-w-0">
      {images.length > 0 && <ImageStrip images={images} large className={item.text ? "mb-2" : undefined} />}
      {item.text && <Markdown text={item.text} caret={streaming} interim={interim} />}
    </div>
  );
});

export function TypingDots({ label = "Agent is working" }: { label?: string }) {
  return (
    <span className="animate-dots inline-flex h-6 items-center gap-1 text-steel" role="status" aria-label={label}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
    </span>
  );
}

export const ThoughtRow = memo(function ThoughtRow({ item, streaming }: { item: Of<"thought">; streaming: boolean }) {
  const [open, setOpen] = useState(EXPAND_ALL);
  const words = wordCount(item.text);
  return (
    <div className="-mx-1">
      <button
        type="button"
        onClick={() => toggle(setOpen)}
        aria-expanded={open}
        className="press-row flex min-h-11 w-full items-center gap-2 rounded-xl px-1 text-left text-[13.5px] text-steel"
      >
        <Icon name="sparkle" size={16} className={cn("shrink-0", streaming && "animate-breathe text-accent")} />
        <span className="font-medium">{streaming ? "Thinking…" : "Thought"}</span>
        {!streaming && <span className="text-steel">· {words} {words === 1 ? "word" : "words"}</span>}
        <Icon name="chevronDown" size={16} className={cn("ml-auto shrink-0 transition-transform duration-150", !open && "-rotate-90")} />
      </button>
      {open && (
        <div className="animate-fade mt-0.5 mb-1 ml-[11px] border-l-2 border-line pl-4 text-[14px] leading-[1.6] whitespace-pre-wrap text-muted italic">
          {item.text}
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Tool calls

/** The agent stopped (interrupted / stopped) with this call unfinished: paused, not spinning. */
function PauseGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="text-violet" role="img" aria-label="Paused">
      <circle cx="12" cy="12" r="9" />
      <path d="M10 9v6M14 9v6" />
    </svg>
  );
}

function StatusGlyph({ status, paused = false }: { status: ToolStatus; paused?: boolean }) {
  if (paused) return <PauseGlyph />;
  switch (status) {
    case "in_progress":
      return <Spinner size={15} className="text-accent" />;
    case "completed":
      return <Icon name="check" size={16} strokeWidth={2.2} className="text-ok" label="Completed" />;
    case "failed":
      return <Icon name="x" size={16} strokeWidth={2.2} className="text-err" label="Failed" />;
    default:
      return <Icon name="clock" size={15} className="text-steel" label="Pending" />;
  }
}

const OUTPUT_TAIL = 12_000;
const OUTPUT_PAGE = 64 * 1024;

/** How much of a long output to show: the tail, growing by 64 KB pages. */
export function outputWindow(length: number, pages: number): { start: number; hidden: number } {
  const shown = Math.min(length, OUTPUT_TAIL + pages * OUTPUT_PAGE);
  return { start: length - shown, hidden: length - shown };
}

/**
 * A command's output as plain text: ANSI colors are stripped and `\r` progress-bar redraws keep
 * only their last state (like the desktop). `live`: the command is still running; the box follows
 * the newest lines unless the reader scrolled up inside it.
 */
export function OutputBlock({ text: raw, label = "Output", live = false }: { text: string; label?: string; live?: boolean }) {
  const [pages, setPages] = useState(0);
  const { text, hidden: dropped } = useMemo(() => cleanTerminalOutput(raw), [raw]);
  const { start, hidden } = outputWindow(text.length, pages);
  const shown = start ? text.slice(start) : text;
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && live && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown, live]);
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-code">
      <div className="flex h-8 items-center justify-between border-b border-line/70 pr-1 pl-3">
        <span className="flex items-center gap-1.5 text-[11px] font-medium tracking-wider text-steel uppercase">
          {label}
          {live && (
            <span className="inline-flex items-center gap-1 tracking-normal text-accent normal-case">
              <span className="animate-breathe h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
              Live
            </span>
          )}
        </span>
        <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} />
      </div>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => {
            noteUserLayoutChange();
            setPages((p) => p + 1);
          }}
          className="press-row min-h-11 w-full border-b border-line/70 px-3 text-[12.5px] font-medium text-accent"
        >
          {formatBytes(hidden)} earlier output hidden · Show {formatBytes(Math.min(hidden, OUTPUT_PAGE))} more
        </button>
      )}
      <pre
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="max-h-[22rem] overflow-auto px-3 py-2.5 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap break-words text-muted"
      >
        {dropped > 0 && !start && <span className="block select-none text-steel">… {dropped.toLocaleString()} earlier characters not shown</span>}
        {shown || " "}
      </pre>
    </div>
  );
}

export function CommandBlock({ command }: { command: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-code">
      <div className="flex items-start gap-1 py-1 pr-1 pl-3">
        <pre className="min-w-0 flex-1 py-1.5 font-mono text-[12.5px] leading-[1.55] whitespace-pre-wrap break-words text-fg">
          <span className="text-ok select-none">$ </span>
          {command}
        </pre>
        <CopyButton text={command} label="Copy command" />
      </div>
    </div>
  );
}

/** +added / −removed line counts of an edit, for the row header. */
function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  if (!additions && !deletions) return null;
  return (
    <span className="shrink-0 font-mono text-[11.5px] tabular" aria-label={`${additions} added, ${deletions} removed`}>
      {additions > 0 && <span className="text-ok">+{additions}</span>}
      {additions > 0 && deletions > 0 && " "}
      {deletions > 0 && <span className="text-err">−{deletions}</span>}
    </span>
  );
}

/**
 * Commands that opened themselves while running. Module-level (not a ref) so the row remembers it when the
 * virtual list unmounts and remounts it; bounded, oldest forgotten first.
 */
const AUTO_OPENED_MAX = 500;
const autoOpened = new Set<string>();
export function rememberAutoOpened(id: string) {
  if (autoOpened.has(id)) return;
  if (autoOpened.size >= AUTO_OPENED_MAX) autoOpened.delete(autoOpened.values().next().value as string);
  autoOpened.add(id);
}
export const wasAutoOpened = (id: string) => autoOpened.has(id);

export const ToolRow = memo(function ToolRow({ item, agentLive = true }: { item: ToolCallItem; agentLive?: boolean }) {
  const hasDetails = !!(item.command || item.output || item.diffs.length || item.locations.length);
  const unfinished = item.status === "pending" || item.status === "in_progress";
  // An unfinished call of an agent that is no longer running (stopped, interrupted) is paused, not spinning.
  const running = unfinished && agentLive;
  const paused = unfinished && !agentLive;
  const failed = item.status === "failed";
  const isCmd = item.toolKind === "execute";
  const [open, setOpen] = useState<boolean | null>(EXPAND_ALL && hasDetails ? true : null);
  // A command that opened itself while running stays open when it finishes (no height jump).
  if (running && isCmd) rememberAutoOpened(item.id);
  const expanded = hasDetails && (open ?? (wasAutoOpened(item.id) || failed));
  // Cheap counts for the header (no real diff until it is expanded).
  const stats = useMemo(() => cheapStatsAll(item.diffs), [item.diffs]);
  const exit = isCmd && failed ? exitCodeOf(item.output) : null;
  const color = failed ? "var(--err)" : paused ? "var(--violet)" : running ? "var(--accent)" : "var(--steel)";
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (!hasDetails) return;
          noteUserLayoutChange();
          setOpen(!expanded);
        }}
        aria-expanded={hasDetails ? expanded : undefined}
        disabled={!hasDetails}
        className={cn("flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left", hasDetails && "press-row")}
      >
        <span
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border"
          style={{
            color,
            borderColor: `color-mix(in srgb, ${color} 22%, var(--border))`,
            background: `color-mix(in srgb, ${color} 8%, transparent)`,
          }}
        >
          <Icon name={TOOL_ICON[item.toolKind] ?? "wrench"} size={15} />
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-[14px]", isCmd && "font-mono text-[13px]", failed ? "text-fg" : "text-fg/90")}>
          {item.title}
        </span>
        {item.diffs.length > 0 && <DiffStat additions={stats.additions} deletions={stats.deletions} />}
        {exit !== null && (
          <span className="shrink-0 rounded-md bg-err/10 px-1.5 py-px font-mono text-[11px] font-medium tabular text-err">exit {exit}</span>
        )}
        <StatusGlyph status={item.status} paused={paused} />
        {hasDetails && (
          <Icon name="chevronDown" size={16} className={cn("shrink-0 text-steel transition-transform duration-150", !expanded && "-rotate-90")} />
        )}
      </button>
      {item.images && item.images.length > 0 && <ImageStrip images={item.images} className="px-3 pb-3 pl-[52px]" />}
      {expanded && (
        <div className="animate-fade space-y-2 px-3 pt-0.5 pb-3">
          {item.command && <CommandBlock command={item.command} />}
          {item.locations.some(isLocalImagePath) && (
            <div className="flex flex-wrap gap-2">
              {item.locations.filter(isLocalImagePath).slice(0, 4).map((p) => (
                <LocalImage key={p} path={p} />
              ))}
            </div>
          )}
          {item.locations.length > 0 && !item.diffs.length && (
            <div className="flex flex-wrap gap-1.5">
              {item.locations.map((loc) => (
                <span
                  key={loc}
                  title={loc}
                  className="inline-flex max-w-full items-center gap-1 truncate rounded-lg border border-line bg-card px-2 py-1 font-mono text-[11.5px] text-muted"
                >
                  {shortPath(loc, 3)}
                </span>
              ))}
            </div>
          )}
          {item.diffs.length > 0 && <DiffList diffs={item.diffs} />}
          {(item.output || (running && isCmd)) && <OutputBlock text={item.output} live={running && isCmd} />}
        </div>
      )}
    </div>
  );
});

export const ToolGroup = memo(function ToolGroup({ items, agentLive = true }: { items: ToolCallItem[]; agentLive?: boolean }) {
  return (
    <div className="divide-y divide-line/70 overflow-hidden rounded-2xl border border-line bg-panel edge">
      {items.map((it) => (
        <ToolRow key={it.id} item={it} agentLive={agentLive} />
      ))}
    </div>
  );
});

// ---------------------------------------------------------------------------

function PlanGlyph({ status }: { status: PlanEntry["status"] }) {
  if (status === "completed")
    return (
      <span className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-ok/90 text-base">
        <Icon name="check" size={12} strokeWidth={3} />
      </span>
    );
  if (status === "in_progress")
    return (
      <span className="relative inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 border-accent">
        <span className="h-2 w-2 rounded-full bg-accent" />
      </span>
    );
  return <span className="inline-block h-[18px] w-[18px] shrink-0 rounded-full border-2 border-line-strong" />;
}

export const PlanCard = memo(function PlanCard({ item }: { item: Of<"plan"> }) {
  const done = item.entries.filter((e) => e.status === "completed").length;
  const total = item.entries.length;
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-panel edge">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <span className="text-[13px] font-semibold text-fg">Plan</span>
        <span className="text-[12.5px] text-steel tabular">
          {done} of {total} done
        </span>
        <div className="ml-auto h-1.5 w-20 overflow-hidden rounded-full bg-raised" aria-hidden>
          <div
            className="h-full w-full origin-left rounded-full bg-ok transition-transform duration-200"
            style={{ transform: `scaleX(${total ? done / total : 0})` }}
          />
        </div>
      </div>
      <ul className="px-4 pb-3">
        {item.entries.map((e, i) => (
          <li key={i} className="flex items-start gap-3 py-1.5">
            <span className="mt-[2px]">
              <PlanGlyph status={e.status} />
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 text-[14px] leading-[1.45]",
                e.status === "completed" ? "text-steel line-through decoration-steel/50" : e.status === "in_progress" ? "font-medium text-fg" : "text-muted",
              )}
            >
              {e.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
});

const NOTICE: Record<Of<"notice">["level"], { icon: IconName; color: string }> = {
  info: { icon: "info", color: "var(--steel)" },
  warn: { icon: "alert", color: "var(--warn)" },
  error: { icon: "alertCircle", color: "var(--err)" },
};

export const NoticeRow = memo(function NoticeRow({ item }: { item: Of<"notice"> }) {
  const meta = NOTICE[item.level] ?? NOTICE.info;
  if (item.level === "info") {
    return (
      <div className="flex items-center gap-3 py-1 text-[12.5px] text-steel" role="note">
        <span className="h-px flex-1 bg-line" />
        <span className="inline-flex max-w-[80%] items-center gap-1.5 text-center">
          <Icon name={meta.icon} size={14} className="shrink-0" />
          {item.text}
        </span>
        <span className="h-px flex-1 bg-line" />
      </div>
    );
  }
  return (
    <div
      role="note"
      className="flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-[13.5px] leading-snug"
      style={{
        color: meta.color,
        borderColor: `color-mix(in srgb, ${meta.color} 28%, var(--border))`,
        background: `color-mix(in srgb, ${meta.color} 7%, transparent)`,
      }}
    >
      <Icon name={meta.icon} size={17} className="mt-px shrink-0" />
      <span className="min-w-0 flex-1 text-fg/90">{item.text}</span>
    </div>
  );
});
