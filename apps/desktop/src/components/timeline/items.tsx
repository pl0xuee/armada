import {
  ArrowRightLeft,
  Brain,
  Check,
  ChevronRight,
  CircleCheck,
  CirclePause,
  CircleX,
  CornerDownRight,
  FilePen,
  FileSearch,
  Globe,
  Info,
  ListChecks,
  MessageSquareX,
  Repeat,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Settings2,
  ShieldX,
  SquareTerminal,
  Timer,
  Trash2,
  TriangleAlert,
  Users,
  Wrench,
} from "lucide-react";
import { m, AnimatePresence } from "motion/react";
import { memo, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { respondPermission } from "@/lib/actions";
import { api } from "@/lib/api";
import { PREVIEW_LINK_HINT, splitLoopbackUrls } from "@/lib/external";
import { pluralize } from "@/lib/format";
import type { Agent, Attachment, PermissionOption, TimelineItem, ToolKind } from "@/lib/types";
import { cn, errorMessage, scrollBehavior } from "@/lib/utils";
import { toast } from "sonner";
import { useUi } from "@/store/ui";
import { RelTime } from "../RelTime";
import { RestoreAction } from "./RestoreAction";
import { Textarea } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { permissionKeyOptions } from "./usePermissionKeys";
import { cheapStatsAll, parsedDiffs } from "./diffCache";
import type { ParsedFileDiff } from "@/lib/diff";
import { usePermissionUi } from "@/store/permissionUi";
import { usePinnedUi } from "@/store/pinnedUi";

const NO_PARSED: ParsedFileDiff[] = [];
import { isImagePath } from "@/lib/images";
import { hasPicture } from "@/lib/inlineImage";
import { stripOutputFence } from "@/lib/terminalOutput";
import { ImageLightbox } from "../ImageLightbox";
import { LocationThumb } from "../LocalImage";
import { useIdentity } from "@/hooks/useIdentity";
import { useMinimal } from "@/hooks/useLook";
import { useSingleKeys } from "@/hooks/useSingleKeys";
import { AttachmentImg } from "../AttachmentImg";
import { AttachmentStrip } from "../AttachmentStrip";
import { CopyButton } from "../CopyButton";
import { DiffStat, FileDiffView } from "../DiffView";
import { Markdown } from "../Markdown";
import { PlanChecklist } from "./PlanChecklist";
import { userMessageFolds, userMessageLines, type MessageRole } from "./collapse";
import { MessageFold } from "./MessageFold";
import { runText } from "./messageFlow";
import { CodeText } from "../CodeText";
import { ProviderGlyph } from "../ProviderGlyph";
import { Button } from "../ui/button";
import { Spinner } from "../ui/misc";

type Item<K extends TimelineItem["kind"]> = Extract<TimelineItem, { kind: K }>;

// ---------------------------------------------------------------- user

export const UserBubble = memo(function UserBubble({
  item,
  awaiting = false,
}: {
  item: Item<"user_message">;
  /** Sent while the agent worked and not answered yet: says when it will be read, until the agent's next output. */
  awaiting?: boolean;
}) {
  // A long paste (a log, a diff) folds; it stays whole for Copy.
  const long = userMessageFolds(item.text);
  const [open, setOpen] = useState(false);
  const folded = long && !open;
  // Kvistcode's own "continue" after a rate limit reset: a quiet line, not a bubble the user wrote.
  if (item.automatic) {
    return (
      <div className="flex justify-end" title={item.text} data-testid="auto-resume-note">
        <div className="flex max-w-[80%] items-center gap-1.5 rounded-full border border-line/70 bg-raised/40 px-3 py-1 text-caption text-muted">
          <Timer className="h-3 w-3 shrink-0 text-warn" aria-hidden />
          <span className="truncate">Resumed automatically after the rate limit reset</span>
          <RelTime ts={item.ts} className="shrink-0 text-micro text-steel" />
        </div>
      </div>
    );
  }
  return (
    <div className="group flex justify-end">
      <div className="relative max-w-[80%]">
        {item.attachments && item.attachments.length > 0 && (
          <AttachmentStrip attachments={item.attachments} size={88} className="mb-1.5 justify-end" />
        )}
        {item.text && (
          <div className="rounded-2xl rounded-br-md border border-line/70 bg-raised/60 text-[14.5px] leading-[1.55] text-fg minimal:m-raised minimal:rounded-[14px] minimal:rounded-br-md minimal:leading-[23px]">
            <div
              dir="auto"
              className={cn(
                "selectable whitespace-pre-wrap break-words px-3.5 py-2 minimal:px-[15px] minimal:py-2.5",
                folded &&
                  "max-h-[22rem] overflow-hidden [mask-image:linear-gradient(to_bottom,#000_calc(100%-3rem),transparent)]",
              )}
            >
              {item.text}
            </div>
            {long && (
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className="flex h-7 w-full items-center justify-center gap-1 rounded-b-2xl border-t border-line/60 text-meta text-steel transition-colors hover:bg-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 minimal:rounded-b-[13px] minimal:rounded-br-[5px]"
              >
                {open ? "Show less" : `Show all ${userMessageLines(item.text).toLocaleString()} lines`}
              </button>
            )}
          </div>
        )}
        {awaiting && (
          <div className="mt-1 flex items-center justify-end gap-1 text-micro text-steel">
            <CornerDownRight className="h-3 w-3" aria-hidden />
            Sent while it was working · it reads this at its next step
          </div>
        )}
        <div className="absolute right-0 top-full z-[1] flex gap-1 pt-0.5 text-micro text-steel opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {item.text && <CopyButton text={item.text} className="h-5" />}
          <RestoreAction item={item} />
          <RelTime ts={item.ts} long className="self-center" />
        </div>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------- agent message

/** Start of an agent turn: avatar and name; the time shows beside it. Rendered once per turn. */
export const TurnHeader = memo(function TurnHeader({ agent, ts }: { agent: Agent; ts: number }) {
  const identity = useIdentity(agent.provider, agent.customAgentId);
  return (
    <div className="group/turn mb-2 flex h-6 items-center gap-2">
      <ProviderGlyph provider={agent.provider} customAgentId={agent.customAgentId} size="xs" />
      <span className="text-small font-semibold text-fg/90">{identity.short}</span>
      <RelTime ts={ts} long className="text-micro text-steel/80" />
    </div>
  );
});

export const AgentMessage = memo(function AgentMessage({
  item,
  parts,
  agent,
  role: wanted = "answer",
  turnOpen = false,
  streaming,
}: {
  /** The message (the first of a run of consecutive ones). */
  item: Item<"agent_message">;
  /** All pieces of a run of consecutive messages (including `item`): rendered as one continuous text. */
  parts?: readonly TimelineItem[];
  agent: Agent;
  /** "narration": a working note between tool calls, quiet and compact. "answer"/"latest": what closes a turn. */
  role?: MessageRole;
  /** The agent is mid-turn. */
  turnOpen?: boolean;
  streaming: boolean;
}) {
  // One way while the turn runs: a message that became a working note stays one until the turn ends. A
  // stray call that shows for a moment and then moves into its sub-agent's card must not flip the
  // message between answer and note typesetting (a jump of tens of pixels each time).
  const noted = useRef(false);
  if (!turnOpen) noted.current = false;
  else if (wanted === "narration") noted.current = true;
  const role: MessageRole = wanted === "latest" && noted.current ? "narration" : wanted;
  const images = item.images ?? [];
  const text = useMemo(() => (parts ? runText(parts) : item.text), [parts, item.text]);
  // Demoted while on screen (the answer in the making turned out to be a working note): ease into the new style.
  const lastRole = useRef(role);
  const demoted = useRef(false);
  if (lastRole.current !== "narration" && role === "narration") demoted.current = true;
  lastRole.current = role;
  return (
    // With text, the row's own bottom padding becomes a 20px gutter for the copy button, so it never
    // prints over the last line (the negative margin keeps the gap to the next row at 20px).
    <div className={cn("group relative", text && "-mb-3 pb-5")}>
      {images.length > 0 && <MessageImages images={images} />}
      {text ? (
        <MessageFold id={item.id} role={role} streaming={streaming} canFold={!hasPicture(text)}>
          <Markdown
            text={text}
            streaming={streaming}
            agentId={agent.id}
            runAgentId={agent.cwd ? agent.id : undefined}
            className={cn("prose-chat", role === "narration" && "prose-narration", demoted.current && "prose-demote")}
          />
        </MessageFold>
      ) : images.length > 0 ? null : !streaming ? (
        <p className="text-small italic text-steel">No reply (the turn ended before any text).</p>
      ) : (
        <div className="flex h-5 items-center gap-1" aria-label="Typing">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1.5 w-1.5 rounded-full bg-steel animate-breathe"
              style={{ animationDelay: `${i * 160}ms` }}
            />
          ))}
        </div>
      )}
      {!streaming && text && (
        <div className="absolute bottom-0 left-0 z-[1] flex opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <CopyButton text={text} className="-ml-1.5 h-5" label="Copy message" />
        </div>
      )}
    </div>
  );
});

/** Pictures the agent put in its reply: shown in full, click to enlarge. */
function MessageImages({ images }: { images: Attachment[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="my-1 flex flex-wrap gap-2">
      {images.map((img, i) => (
        <button
          key={`${img.name}-${i}`}
          type="button"
          onClick={() => setOpen(i)}
          aria-label={`View ${img.name}`}
          className="overflow-hidden rounded-xl border border-line-strong bg-base transition-transform duration-150 hover:scale-[1.01] active:scale-[0.99]"
        >
          <AttachmentImg
            attachment={img}
            placeholder="h-[180px] w-[240px]"
            className="block max-h-[420px] w-auto max-w-full object-contain"
            draggable={false}
          />
        </button>
      ))}
      <ImageLightbox images={images} index={open} onIndexChange={setOpen} />
    </div>
  );
}

// ---------------------------------------------------------------- thought

export const ThoughtBlock = memo(function ThoughtBlock({
  item,
  live,
  agentId,
}: {
  item: Item<"thought">;
  live: boolean;
  agentId?: string;
}) {
  const [open, setOpen] = useState(live);
  useEffect(() => {
    if (live) setOpen(true);
  }, [live]);
  const preview = item.text
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (
    <div className="text-small">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group flex max-w-full items-center gap-1.5 rounded-md py-0.5 pr-1.5 text-steel transition-colors hover:text-muted minimal:h-7 minimal:gap-2 minimal:py-0"
      >
        <Brain className={cn("h-3.5 w-3.5 shrink-0", live && "text-accent animate-breathe")} />
        <span className={cn("font-medium", live && "text-muted")}>Thought</span>
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform duration-150", open && "rotate-90")} />
        {!open && <span className="min-w-0 truncate text-steel">{preview}</span>}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <m.div
            initial={{ opacity: 0, y: -2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            className="ml-[7px] mt-1 border-l border-line-strong pl-3.5"
          >
            <Markdown
              text={item.text || "…"}
              streaming={live}
              agentId={agentId}
              className="!text-small italic !leading-[20px] text-muted [&_*]:!text-muted"
            />
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
});

// ---------------------------------------------------------------- tool call

export const TOOL_ICON: Record<ToolKind, ComponentType<{ className?: string }>> = {
  read: FileSearch,
  edit: FilePen,
  delete: Trash2,
  move: ArrowRightLeft,
  search: Search,
  execute: SquareTerminal,
  think: Brain,
  fetch: Globe,
  other: Wrench,
};

function ToolStatusIcon({
  status,
  stalled,
  minimal,
}: {
  status: Item<"tool_call">["status"];
  stalled: boolean;
  minimal: boolean;
}) {
  if (stalled) return <CirclePause className="h-3.5 w-3.5 text-violet" aria-label="Paused" />;
  if (status === "in_progress" || status === "pending") return <Spinner className="h-3.5 w-3.5" />;
  if (status === "failed") return <CircleX className="h-3.5 w-3.5 text-err" aria-label="Failed" />;
  if (minimal) return <Check className="h-3.5 w-3.5 text-ok/70" aria-label="Completed" />;
  return <CircleCheck className="h-3.5 w-3.5 text-ok/60" aria-label="Completed" />;
}

/** Only the tail of very long output is rendered (and processed). */
const OUTPUT_CAP = 200_000;

// CSI (colors, cursor moves), OSC (titles, hyperlinks) and other two-byte escapes.
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Terminal output as plain text: strips ANSI escapes and applies carriage returns the way a
 * terminal would (a progress bar redrawn with \r keeps only its last state).
 */
export function cleanTerminalOutput(raw: string): { text: string; hidden: number } {
  const hidden = Math.max(0, raw.length - OUTPUT_CAP);
  const tail = hidden ? raw.slice(hidden) : raw;
  const text = tail
    .replace(ANSI_RE, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const cr = line.lastIndexOf("\r");
      return cr >= 0 ? line.slice(cr + 1) : line;
    })
    .join("\n");
  return { text: stripOutputFence(text, hidden > 0), hidden };
}

/** Plain text with loopback URLs (dev servers) as links; the navigation guard opens them in Preview. */
const LinkifiedText = memo(function LinkifiedText({ text }: { text: string }) {
  const parts = useMemo(() => splitLoopbackUrls(text), [text]);
  if (parts.length === 1 && typeof parts[0] === "string") return <>{text}</>;
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          p
        ) : (
          <a
            key={i}
            href={p.url}
            title={PREVIEW_LINK_HINT}
            className="underline decoration-accent/50 underline-offset-2 hover:text-accent"
          >
            {p.url}
          </a>
        ),
      )}
    </>
  );
});

/** Lines shown in the compact tail of a command's output. */
const TAIL_LINES = 6;
/** Visual height budget of the compact tail: padding + a command line + TAIL_LINES lines (12px * 1.6). */
const TAIL_MAX_HEIGHT = 20 + 24 + TAIL_LINES * 19.2;

export function TerminalOutput({
  command,
  output,
  live,
  maxHeight = 300,
  compact = false,
}: {
  command: string | null;
  output: string;
  live?: boolean;
  maxHeight?: number;
  /** Chat mode: only the last few (wrapped) lines, with "Show all N lines". */
  compact?: boolean;
}) {
  const ref = useRef<HTMLPreElement>(null);
  // Follow new output only while the user hasn't scrolled up inside this box.
  const stick = useRef(true);
  const [all, setAll] = useState(false);
  const { text, hidden } = useMemo(() => cleanTerminalOutput(output), [output]);
  const lines = useMemo(() => (compact ? text.replace(/\n+$/, "").split("\n") : []), [compact, text]);
  const tail = compact && !all && lines.length > TAIL_LINES;
  // Footer space is reserved from the start for a running command (and kept afterwards), so the box
  // never changes height when the output first outgrows the tail.
  const footer = useRef(false);
  if (compact && (live || lines.length > TAIL_LINES)) footer.current = true;
  useEffect(() => {
    const el = ref.current;
    if (el && (live || tail) && stick.current) el.scrollTop = el.scrollHeight;
  }, [text, live, all, tail]);
  const shown = tail ? lines.slice(-TAIL_LINES).join("\n") : text;
  return (
    <div className="group/term relative bg-code">
      {(command || text) && (
        <div className="absolute right-1.5 top-1.5 z-[1] opacity-0 transition-opacity focus-within:opacity-100 group-hover/term:opacity-100">
          <CopyButton text={command ? `${command}\n${text}` : text} />
        </div>
      )}
      <pre
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className={cn(
          "selectable px-3.5 py-2.5 font-mono text-caption leading-[1.6] text-fg/85",
          compact ? "overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]" : "overflow-auto",
          tail && "overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,#000_1.6rem)]",
        )}
        // Compact tail: a fixed visual-line budget, so wrapped lines can't make the box (and the chat) jump.
        style={{ maxHeight: compact && !all ? TAIL_MAX_HEIGHT : maxHeight }}
      >
        {command && (
          <div className="mb-1 text-fg">
            <span className="select-none text-accent">❯ </span>
            <CodeText code={command} lang="shellscript" />
          </div>
        )}
        {hidden > 0 && (
          <div className="mb-1 select-none text-steel">… {hidden.toLocaleString()} earlier characters not shown</div>
        )}
        <LinkifiedText text={shown} />
        {live && <span className="caret" />}
        {!text && !live && !command && <span className="text-steel">No output</span>}
      </pre>
      {compact &&
        footer.current &&
        (lines.length > TAIL_LINES ? (
          <button
            type="button"
            onClick={() => setAll((v) => !v)}
            className="flex h-7 w-full items-center justify-center gap-1 border-t border-line/60 text-meta text-steel transition-colors hover:bg-raised/40 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
          >
            {all ? "Show less" : `Show all ${lines.length.toLocaleString()} lines`}
          </button>
        ) : (
          <div className="flex h-7 w-full items-center justify-center border-t border-line/60 text-meta tabular-nums text-steel">
            {live ? "Live" : pluralize(text ? lines.length : 0, "line")}
          </div>
        ))}
    </div>
  );
}

/** "exit 1" from the end of a failed command's output, when it says so. */
function exitCodeOf(output: string): string | null {
  const m = /(?:exit(?:ed)?(?: with)?(?: code| status)?|code)[:= ]+(-?\d+)\s*\)?\s*$/i.exec(
    stripOutputFence(output.slice(-400), output.length > 400)
      .trimEnd()
      .slice(-200),
  );
  return m ? m[1] : null;
}

const PATH_TITLE_RE = /^(Read|Edit|Write|Create|Update|Delete|Remove|Move|Rename|View|Open)\s+(\S+)$/i;
const RUN_TITLE_RE = /^(?:run(?:ning)?|ran|bash|execute)\s+/i;

/** "Read src/a/b.ts": the file as a tidy chip (folder muted, file name emphasised); other titles stay plain text. */
const ToolTitle = memo(function ToolTitle({ title, kind }: { title: string; kind: ToolKind }) {
  const m = kind === "execute" ? null : PATH_TITLE_RE.exec(title);
  if (!m || !/[./\\]/.test(m[2])) return <>{title}</>;
  const path = m[2];
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
  return (
    <>
      {m[1]}{" "}
      <span className="rounded-md bg-raised/60 px-1.5 py-px font-mono text-meta text-steel">
        {path.slice(0, cut)}
        <span className="font-medium text-fg/85">{path.slice(cut)}</span>
      </span>
    </>
  );
});

/** Minimal look: what was done in words, what it was done to in mono ("Read package.json", "Ran npm test"). */
const StepTitle = memo(function StepTitle({
  title,
  kind,
  running,
}: {
  title: string;
  kind: ToolKind;
  running: boolean;
}) {
  const path = kind === "execute" ? null : PATH_TITLE_RE.exec(title);
  const verb = kind === "execute" ? (running ? "Running" : "Ran") : path?.[1];
  const rest = kind === "execute" ? title.replace(RUN_TITLE_RE, "") : path?.[2];
  if (!verb || !rest) return <>{title}</>;
  return (
    <>
      <span className="font-medium text-muted">{verb}</span> <span className="font-mono text-caption">{rest}</span>
    </>
  );
});

export const ToolCallCard = memo(function ToolCallCard({
  item,
  agentId,
  agentLive = true,
  nested,
}: {
  item: Item<"tool_call">;
  agentId: string;
  /** Inside a sub-agent card or an expanded trace: same quiet row. */
  nested?: boolean;
  /** False when the agent process isn't running (interrupted/stopped): unfinished calls are paused, not spinning. */
  agentLive?: boolean;
}) {
  const unfinished = item.status === "in_progress" || item.status === "pending";
  const running = unfinished && agentLive;
  const stalled = unfinished && !agentLive;
  const hasBody = item.diffs.length > 0 || item.output.length > 0 || !!item.command;
  const [open, setOpen] = useState<boolean | null>(null);
  // A command that opened itself while running stays open when it finishes (no height jump).
  const autoOpened = useRef(false);
  if (running && item.toolKind === "execute") autoOpened.current = true;
  const expanded = open ?? (autoOpened.current || item.status === "failed");
  const Icon = TOOL_ICON[item.toolKind] ?? Wrench;
  const hasDiffs = item.diffs.length > 0;
  // Cheap counts for the header; the structured diff is only computed when expanded (cached).
  const stats = useMemo(() => cheapStatsAll(item.diffs), [item.diffs]);
  const parsed = useMemo(
    () => (expanded && hasDiffs ? parsedDiffs(item.id, item.diffs) : NO_PARSED),
    [expanded, hasDiffs, item.id, item.diffs],
  );
  const isCmd = item.toolKind === "execute";
  const failed = item.status === "failed";
  const exit = isCmd && failed ? exitCodeOf(item.output) : null;
  const minimal = useMinimal();

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border transition-colors minimal:rounded-[11px]",
        !nested && "-mx-1.5",
        expanded && hasBody ? "tl-well border-line bg-card/40" : "border-transparent",
        failed && expanded && "border-err/30",
      )}
    >
      <button
        type="button"
        disabled={!hasBody}
        onClick={() => setOpen(!expanded)}
        aria-expanded={hasBody ? expanded : undefined}
        title={item.title}
        className={cn(
          "group/row flex w-full items-center gap-2 px-1.5 text-left text-steel transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 disabled:cursor-default",
          nested ? "h-7" : "h-8 minimal:h-7",
          hasBody && "hover:bg-raised/40 hover:text-muted",
        )}
      >
        <Icon className={cn("h-3.5 w-3.5 shrink-0", running && "text-accent")} aria-hidden />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-small",
            isCmd && !minimal && "font-mono text-caption",
            running ? "text-muted" : failed ? "text-err/90" : "",
          )}
        >
          {minimal ? (
            <StepTitle title={item.title} kind={item.toolKind} running={running} />
          ) : (
            <ToolTitle title={item.title} kind={item.toolKind} />
          )}
        </span>
        {hasDiffs && <DiffStat additions={stats.additions} deletions={stats.deletions} />}
        {exit !== null && (
          <span className="shrink-0 rounded-md bg-err/10 px-1.5 text-micro font-medium tabular-nums text-err">
            exit {exit}
          </span>
        )}
        <ToolStatusIcon status={item.status} stalled={stalled} minimal={minimal} />
        {hasBody && (
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 text-steel transition-transform duration-150 group-hover/row:text-muted",
              expanded && "rotate-90",
            )}
          />
        )}
      </button>
      <ToolImages item={item} agentId={agentId} />
      <AnimatePresence initial={false}>
        {expanded && hasBody && (
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="border-t border-line/70"
          >
            {(item.command || item.output) && !hasDiffs && (
              <TerminalOutput command={item.command} output={item.output} live={running} compact />
            )}
            {parsed.length > 0 && (
              <div className="divide-y divide-line">
                {parsed.map((f, i) => (
                  <FileDiffView key={i} file={f} flush maxHeight={360} />
                ))}
              </div>
            )}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
});

// ---------------------------------------------------------------- permission

const OPTION_LABEL: Record<PermissionOption["kind"], string> = {
  allow_once: "Allowed once",
  allow_always: "Always allowed",
  reject_once: "Denied",
  reject_always: "Always denied",
};

export const PermissionCard = memo(function PermissionCard({
  item,
  agent,
  compact,
  keyboard,
  reasonOpen,
  onReasonOpenChange,
}: {
  item: Item<"permission">;
  agent: Agent;
  compact?: boolean;
  /** This request answers to Y / A / N (the latest pending one in the visible agent). */
  keyboard?: boolean;
  /** "Deny with reason" editor, controlled by the timeline (Shift+N). */
  reasonOpen?: boolean;
  onReasonOpenChange?: (open: boolean) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  // The letter hints (A, D, ⇧D) only mean something while one-letter shortcuts are on.
  const letterKeys = useSingleKeys();
  const [localReason, setLocalReason] = useState(false);
  // The draft lives in a store so it survives the row being virtualized out of view.
  const reason = usePermissionUi((s) => s.reasonDraft[item.requestId] ?? "");
  const armed = usePermissionUi((s) => Boolean(s.armed[item.requestId]));
  // Its actions sit above the message box (ApprovalDock); this card keeps the details.
  const docked = usePermissionUi((s) => Boolean(s.docked[item.requestId])) && !compact;
  const setReason = (text: string) => usePermissionUi.getState().setReasonDraft(item.requestId, text);
  const identity = useIdentity(agent.provider, agent.customAgentId);
  const parsed = useMemo(
    () => (item.resolution === null && !compact ? parsedDiffs(item.id, item.diffs) : NO_PARSED),
    [item.resolution, compact, item.id, item.diffs],
  );
  const resolved = item.resolution !== null;
  const chosen = item.options.find((o) => o.id === item.resolution);
  const showReason = reasonOpen ?? localReason;
  const setShowReason = onReasonOpenChange ?? setLocalReason;
  const keyed = useMemo(() => permissionKeyOptions(item), [item]);
  const reasonRef = useRef<HTMLFormElement>(null);
  // Bring the editor into view inside the timeline scroller only (scrollIntoView would also
  // scroll overflow-hidden ancestors and shift the whole window).
  useEffect(() => {
    if (showReason && reasonRef.current) revealInScroller(reasonRef.current);
  }, [showReason]);
  // Keyboard approvals only act while this card is on screen.
  const cardRef = useRef<HTMLDivElement>(null);
  const pendingNow = item.resolution === null;
  useEffect(() => {
    const el = cardRef.current;
    if (!el || !keyboard || !pendingNow) return;
    const id = item.requestId;
    const io = new IntersectionObserver(
      ([entry]) => usePermissionUi.getState().setVisible(id, entry.isIntersecting && entry.intersectionRatio > 0.25),
      { threshold: [0, 0.25, 0.5] },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      usePermissionUi.getState().setVisible(id, false);
    };
  }, [keyboard, pendingNow, item.requestId]);
  // Forget per-request UI state once answered.
  useEffect(() => {
    if (!pendingNow) usePermissionUi.getState().clear(item.requestId);
  }, [pendingNow, item.requestId]);
  // Key hints go on the option the shortcut actually picks (by kind, first match).
  const keyHint = (o: PermissionOption): string | null => {
    if (!keyboard || !letterKeys) return null;
    if (keyed.allow?.id === o.id) return "A";
    if (keyed.always?.id === o.id) return "⇧A";
    if (keyed.deny?.id === o.id) return "D";
    return null;
  };
  const shortcutFor = (o: PermissionOption): string | undefined => {
    if (!keyboard || !letterKeys) return undefined;
    if (keyed.allow?.id === o.id) return "A Y";
    if (keyed.always?.id === o.id) return "Shift+A";
    if (keyed.deny?.id === o.id) return "D N";
    return undefined;
  };

  if (resolved) {
    const cancelled = item.resolution === "cancelled" || !chosen;
    const allowed = chosen?.kind.startsWith("allow");
    const Icon = cancelled ? ShieldX : allowed ? ShieldCheck : ShieldX;
    return (
      <div className="flex h-8 items-center gap-2 px-1.5 text-small">
        <span
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border",
            cancelled
              ? "border-line text-steel"
              : allowed
                ? "border-ok/25 bg-ok/10 text-ok"
                : "border-err/25 bg-err/10 text-err",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-muted">{item.title}</span>
        <span
          className={cn("shrink-0 text-meta font-medium", cancelled ? "text-steel" : allowed ? "text-ok" : "text-err")}
        >
          {cancelled ? "Cancelled" : (OPTION_LABEL[chosen.kind] ?? chosen.name)}
        </span>
      </div>
    );
  }

  const answer = async (o: PermissionOption) => {
    if (busy) return;
    setBusy(o.id);
    await respondPermission(agent.id, item, o);
    setBusy(null);
  };

  const denyWithReason = async () => {
    const text = reason.trim();
    if (!keyed.deny || !text || busy) return;
    setBusy(keyed.deny.id);
    // If the deny didn't go through, don't send the reason as if it had.
    if (!(await respondPermission(agent.id, item, keyed.deny))) {
      setBusy(null);
      return;
    }
    try {
      await api.sendPrompt(agent.id, text);
      setReason("");
      setShowReason(false);
    } catch (e) {
      toast.error("Denied, but couldn't send your reason", { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      ref={cardRef}
      role="group"
      tabIndex={keyboard ? 0 : undefined}
      data-permission-request={item.requestId}
      aria-label={`Approval needed: ${item.title}${keyboard ? ". Enter allows once." : ""}`}
      data-tone="warn"
      className="tl-card relative overflow-hidden rounded-2xl border border-warn/40 bg-gradient-to-b from-warn/[0.09] to-card shadow-[0_0_0_1px_color-mix(in_srgb,var(--warn)_10%,transparent),0_12px_40px_-16px_color-mix(in_srgb,var(--warn)_45%,transparent)] edge minimal:border-warn/30"
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-warn/70 to-transparent" />
      <div className="flex items-start gap-3 px-4 pb-3 pt-3.5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-warn/40 bg-warn/15 text-warn">
          <ShieldAlert className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="eyebrow text-warn">{identity.short} needs your approval</div>
          <div
            className={cn(
              "mt-0.5 break-words text-[14px] font-medium text-fg",
              item.toolKind === "execute" && "font-mono text-body",
            )}
          >
            {item.title}
          </div>
        </div>
      </div>
      {(item.command || parsed.length > 0) && !compact && (
        <div className="mx-4 mb-3 overflow-hidden rounded-xl border border-line">
          {item.command && <TerminalOutput command={item.command} output="" maxHeight={160} />}
          {parsed.length > 0 && (
            <div className="divide-y divide-line">
              {parsed.map((f, i) => (
                <FileDiffView key={i} file={f} flush maxHeight={280} />
              ))}
            </div>
          )}
        </div>
      )}
      {docked ? (
        <div className="border-t border-warn/15 bg-base/30 px-4 py-2 text-caption text-steel">
          Answer with the buttons above the message box.
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 border-t border-warn/15 bg-base/30 px-4 py-3">
          {item.options.map((o, i) => {
            const allow = o.kind.startsWith("allow");
            const hint = keyHint(o);
            return (
              <Button
                key={o.id}
                size="sm"
                disabled={busy !== null}
                variant={allow ? (i === 0 ? "warn" : "secondary") : "danger"}
                onClick={() => void answer(o)}
                aria-keyshortcuts={shortcutFor(o)}
                className={cn(o.kind === "reject_once" || o.kind === "reject_always" ? "sm:ml-auto" : "")}
              >
                {busy === o.id ? <Spinner className="h-3.5 w-3.5 text-current" /> : null}
                {o.name}
                {hint && <Kbd className="ml-0.5 border-current/25 bg-transparent text-current opacity-75">{hint}</Kbd>}
              </Button>
            );
          })}
          {keyed.deny && !showReason && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setShowReason(true)}
              aria-keyshortcuts={keyboard && letterKeys ? "Shift+D Shift+N" : undefined}
            >
              <MessageSquareX />
              Deny with reason…
              {keyboard && letterKeys && <Kbd className="ml-0.5">⇧D</Kbd>}
            </Button>
          )}
        </div>
      )}
      {armed && keyed.always && (
        <div
          role="status"
          className="border-t border-warn/25 bg-warn/[0.12] px-4 py-2 text-caption font-medium text-warn"
        >
          Press <Kbd className="mx-0.5 border-warn/40 text-warn">⇧A</Kbd> again to always allow “{keyed.always.name}”.
          This can't be undone for this session.
        </div>
      )}
      {showReason && keyed.deny && (
        <form
          ref={reasonRef}
          className="border-t border-warn/15 bg-base/40 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            void denyWithReason();
          }}
        >
          <label htmlFor={`reason-${item.id}`} className="mb-1.5 block text-caption font-medium text-muted">
            Tell {identity.short} what to do instead
          </label>
          <Textarea
            id={`reason-${item.id}`}
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                void denyWithReason();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setShowReason(false);
              }
            }}
            placeholder="e.g. Don't run migrations against the dev DB; generate the SQL file only."
            className="min-h-16"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <span className="mr-auto text-micro text-steel">
              Denies this request, then sends your note as the next message.
            </span>
            <Button size="sm" variant="ghost" type="button" onClick={() => setShowReason(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" type="submit" disabled={!reason.trim() || busy !== null}>
              {busy === keyed.deny.id && <Spinner className="h-3.5 w-3.5 text-current" />}
              Deny & send
            </Button>
          </div>
        </form>
      )}
    </m.div>
  );
});

// ---------------------------------------------------------------- plan

export const PlanCard = memo(function PlanCard({ item }: { item: Item<"plan"> }) {
  const done = item.entries.filter((e) => e.status === "completed").length;
  const total = item.entries.length;
  // While the plan is pinned above the composer it is the live view; this card is the quiet record.
  const pinned = usePinnedUi((s) => Boolean(s.planPinned[item.agentId]));
  return (
    <div className="tl-card rounded-xl border border-line bg-card/50 p-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <ListChecks className="h-4 w-4 text-accent" />
        <span className="text-small font-semibold">Plan</span>
        <span className="text-meta text-steel tabular">
          {done} of {total}
        </span>
        <div className="ml-auto h-1 w-24 overflow-hidden rounded-full bg-raised">
          <div
            className={cn("h-full origin-left rounded-full bg-accent", !pinned && "transition-transform duration-300")}
            style={{ transform: `scaleX(${total ? done / total : 0})` }}
          />
        </div>
      </div>
      <PlanChecklist entries={item.entries} still={pinned} />
    </div>
  );
});

// ---------------------------------------------------------------- notice

export const NoticeBanner = memo(function NoticeBanner({
  item,
  agent,
  lastPrompt,
  isLatest,
}: {
  item: Item<"notice">;
  agent?: Agent;
  /** The last user message (text and images), for "Retry". */
  lastPrompt?: { text: string; attachments?: Attachment[] } | null;
  /** Only the newest error offers recovery actions. */
  isLatest?: boolean;
}) {
  const Icon = item.level === "error" ? CircleX : item.level === "warn" ? TriangleAlert : Info;
  const [retrying, setRetrying] = useState(false);
  // A usage-limit failure is handled by the single limit card above the composer.
  const limitCard =
    item.level === "error" &&
    !!agent?.rateLimited &&
    agent.status !== "interrupted" &&
    agent.status !== "stopped" &&
    !!isLatest;
  const recover = item.level === "error" && agent && isLatest && !limitCard;
  const retry = async () => {
    if (!agent || !lastPrompt || retrying) return;
    setRetrying(true);
    try {
      // A shut-down / interrupted agent has to be brought back first.
      if (!agent.running) await api.resumeAgent(agent.id, false);
      await api.sendPrompt(agent.id, lastPrompt.text, lastPrompt.attachments ?? []);
    } catch (e) {
      toast.error("Couldn't retry", { description: errorMessage(e) });
    } finally {
      setRetrying(false);
    }
  };
  if (limitCard) return null;
  return (
    <div
      role={item.level === "error" ? "alert" : "status"}
      className={cn(
        "rounded-xl border text-small minimal:rounded-[11px]",
        item.level === "error" && "border-err/30 bg-err/[0.07] text-err minimal:border-err/20",
        item.level === "warn" && "border-warn/30 bg-warn/[0.07] text-warn minimal:border-warn/20",
        item.level === "info" && "tl-well border-line bg-card/40 text-muted",
      )}
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <Icon className="mt-px h-3.5 w-3.5 shrink-0" />
        <span className="selectable">{item.text}</span>
        <RelTime ts={item.ts} className="ml-auto shrink-0 text-micro text-steel" />
      </div>
      {recover && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-err/20 px-2 py-1.5">
          {lastPrompt && agent.running && (
            <Button size="xs" variant="ghost" className="text-fg" disabled={retrying} onClick={() => void retry()}>
              {retrying ? <Spinner className="h-3 w-3" /> : <RotateCcw className="!h-3 !w-3" />}
              Retry last message
            </Button>
          )}
          {agent.provider !== "custom" && !agent.rateLimited && (
            <Button size="xs" variant="ghost" className="text-fg" onClick={() => useUi.getState().setMoveAgent(agent)}>
              <Repeat className="!h-3 !w-3" />
              Switch account
            </Button>
          )}
          {agent.provider !== "custom" && (
            <Button size="xs" variant="ghost" className="text-fg" onClick={() => useUi.getState().setView("accounts")}>
              <Users className="!h-3 !w-3" />
              Accounts
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            className="text-fg"
            onClick={() => useUi.getState().openSettings(agent.provider === "custom" ? "agents" : "providers")}
          >
            <Settings2 className="!h-3 !w-3" />
            Open settings
          </Button>
        </div>
      )}
    </div>
  );
});

/** Screenshots returned by the tool, or image files it touched, shown without expanding the card. */
function ToolImages({ item, agentId }: { item: Item<"tool_call">; agentId: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const [extra, setExtra] = useState<Attachment[]>([]);
  const images = item.images ?? [];
  const locationImages = images.length === 0 ? item.locations.filter(isImagePath) : [];
  if (images.length === 0 && locationImages.length === 0) return null;
  const shown = images.length > 0 ? images : extra;
  return (
    <div className="flex flex-wrap gap-2 border-t border-line px-2.5 py-2.5">
      {images.map((img, i) => (
        <button
          key={`${img.name}-${i}`}
          type="button"
          onClick={() => setOpen(i)}
          aria-label={`View ${img.name}`}
          className="overflow-hidden rounded-xl border border-line-strong bg-base transition-transform duration-150 hover:scale-[1.01] active:scale-[0.99]"
        >
          <AttachmentImg
            attachment={img}
            placeholder="h-[140px] w-[200px]"
            className="block max-h-[320px] w-auto max-w-full object-contain"
            draggable={false}
          />
        </button>
      ))}
      {locationImages.map((path) => (
        <LocationThumb
          key={path}
          agentId={agentId}
          path={path}
          onOpen={(image) => {
            setExtra([image]);
            setOpen(0);
          }}
        />
      ))}
      <ImageLightbox images={shown} index={open} onIndexChange={setOpen} />
    </div>
  );
}

/** Scroll the nearest scrollable ancestor so `el` is fully visible (never moves other ancestors). */
function revealInScroller(el: HTMLElement) {
  let p = el.parentElement;
  while (p && !(p.scrollHeight > p.clientHeight && /auto|scroll/.test(getComputedStyle(p).overflowY))) {
    p = p.parentElement;
  }
  if (!p) return;
  const box = p.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.bottom > box.bottom - 16) p.scrollBy({ top: r.bottom - box.bottom + 16, behavior: scrollBehavior() });
  else if (r.top < box.top + 16) p.scrollBy({ top: r.top - box.top - 16, behavior: scrollBehavior() });
}
