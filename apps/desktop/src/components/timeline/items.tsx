import {
  ArrowRightLeft,
  Brain,
  ChevronRight,
  CircleCheck,
  CirclePause,
  CircleX,
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
  Trash2,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { m, AnimatePresence } from "motion/react";
import { memo, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { respondPermission } from "@/lib/actions";
import { api } from "@/lib/api";
import type { Agent, Attachment, PermissionOption, TimelineItem, ToolKind } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { toast } from "sonner";
import { useUi } from "@/store/ui";
import { RelTime } from "../RelTime";
import { Textarea } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { permissionKeyOptions } from "./usePermissionKeys";
import { cheapStatsAll, parsedDiffs } from "./diffCache";
import type { ParsedFileDiff } from "@/lib/diff";
import { usePermissionUi } from "@/store/permissionUi";

const NO_PARSED: ParsedFileDiff[] = [];
import { attachmentSrc } from "@/lib/attachments";
import { isImagePath } from "@/lib/images";
import { ImageLightbox } from "../ImageLightbox";
import { LocationThumb } from "../LocalImage";
import { useIdentity } from "@/hooks/useIdentity";
import { AttachmentStrip } from "../AttachmentStrip";
import { CopyButton } from "../CopyButton";
import { DiffStat, FileDiffView } from "../DiffView";
import { Markdown } from "../Markdown";
import { ProviderGlyph } from "../ProviderGlyph";
import { Button } from "../ui/button";
import { Spinner } from "../ui/misc";

type Item<K extends TimelineItem["kind"]> = Extract<TimelineItem, { kind: K }>;

// ---------------------------------------------------------------- user

export const UserBubble = memo(function UserBubble({ item }: { item: Item<"user_message"> }) {
  return (
    <div className="group flex justify-end pl-6 @lg:pl-12">
      <div className="relative max-w-[min(680px,88%)]">
        {item.attachments && item.attachments.length > 0 && (
          <AttachmentStrip attachments={item.attachments} size={88} className="mb-1.5 justify-end" />
        )}
        {item.text && (
          <div className="selectable whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-line-strong bg-gradient-to-b from-gunmetal/90 to-gunmetal/60 px-3.5 py-2.5 text-[13.5px] leading-relaxed text-fg shadow-[0_6px_20px_-12px_rgba(0,0,0,0.6)] edge">
            {item.text}
          </div>
        )}
        <div className="mt-1 flex justify-end gap-1 text-[10.5px] text-steel opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {item.text && <CopyButton text={item.text} className="h-5" />}
          <RelTime ts={item.ts} long className="self-center" />
        </div>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------- agent message

export const AgentMessage = memo(function AgentMessage({
  item,
  agent,
  showHeader,
  streaming,
}: {
  item: Item<"agent_message">;
  agent: Agent;
  showHeader: boolean;
  streaming: boolean;
}) {
  const identity = useIdentity(agent.provider, agent.customAgentId);
  return (
    <div className="group">
      {showHeader && (
        <div className="mb-1.5 flex items-center gap-2">
          <ProviderGlyph provider={agent.provider} customAgentId={agent.customAgentId} size="xs" />
          <span className="text-[12px] font-medium text-muted">{identity.short}</span>
          <RelTime ts={item.ts} long className="text-[10.5px] text-steel" />
        </div>
      )}
      {item.text ? (
        <Markdown text={item.text} streaming={streaming} agentId={agent.id} />
      ) : !streaming ? (
        <p className="text-[12.5px] italic text-steel">No reply (the turn ended before any text).</p>
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
      {!streaming && item.text && (
        <div className="mt-1 flex opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <CopyButton text={item.text} className="-ml-1.5" label="Copy message" />
        </div>
      )}
    </div>
  );
});

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
    <div className="text-[12.5px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group flex max-w-full items-center gap-1.5 rounded-md py-0.5 pr-1.5 text-steel transition-colors hover:text-muted"
      >
        <Brain className={cn("h-3.5 w-3.5 shrink-0", live && "text-accent animate-breathe")} />
        <span className={cn("font-medium", live && "text-muted")}>{live ? "Thinking…" : "Thought"}</span>
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform duration-150", open && "rotate-90")} />
        {!open && <span className="min-w-0 truncate text-steel/80">{preview}</span>}
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
              className="!text-[12.5px] italic !leading-relaxed text-muted [&_*]:!text-muted"
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

function ToolStatusIcon({ status, stalled }: { status: Item<"tool_call">["status"]; stalled: boolean }) {
  if (stalled) return <CirclePause className="h-3.5 w-3.5 text-violet" aria-label="Paused" />;
  if (status === "in_progress" || status === "pending") return <Spinner className="h-3.5 w-3.5" />;
  if (status === "failed") return <CircleX className="h-3.5 w-3.5 text-err" aria-label="Failed" />;
  return <CircleCheck className="h-3.5 w-3.5 text-ok/80" aria-label="Completed" />;
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
  return { text, hidden };
}

export function TerminalOutput({
  command,
  output,
  live,
  maxHeight = 300,
}: {
  command: string | null;
  output: string;
  live?: boolean;
  maxHeight?: number;
}) {
  const ref = useRef<HTMLPreElement>(null);
  // Follow new output only while the user hasn't scrolled up inside this box.
  const stick = useRef(true);
  const { text, hidden } = useMemo(() => cleanTerminalOutput(output), [output]);
  useEffect(() => {
    const el = ref.current;
    if (el && live && stick.current) el.scrollTop = el.scrollHeight;
  }, [text, live]);
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
        className="selectable overflow-auto px-3.5 py-2.5 font-mono text-[12px] leading-[1.6] text-fg/85"
        style={{ maxHeight }}
      >
        {command && (
          <div className="mb-1 text-fg">
            <span className="select-none text-accent">❯ </span>
            {command}
          </div>
        )}
        {hidden > 0 && (
          <div className="mb-1 select-none text-steel">… {hidden.toLocaleString()} earlier characters not shown</div>
        )}
        {text}
        {live && <span className="caret" />}
        {!text && !live && !command && <span className="text-steel">No output</span>}
      </pre>
    </div>
  );
}

export const ToolCallCard = memo(function ToolCallCard({
  item,
  agentId,
  agentLive = true,
  nested,
}: {
  item: Item<"tool_call">;
  agentId: string;
  /** Inside a sub-agent card: tighter row. */
  nested?: boolean;
  /** False when the agent process isn't running (interrupted/stopped): unfinished calls are paused, not spinning. */
  agentLive?: boolean;
}) {
  const unfinished = item.status === "in_progress" || item.status === "pending";
  const running = unfinished && agentLive;
  const stalled = unfinished && !agentLive;
  const hasBody = item.diffs.length > 0 || item.output.length > 0 || !!item.command;
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? ((running && item.toolKind === "execute") || item.status === "failed");
  const Icon = TOOL_ICON[item.toolKind] ?? Wrench;
  const hasDiffs = item.diffs.length > 0;
  // Cheap counts for the header; the structured diff is only computed when expanded (cached).
  const stats = useMemo(() => cheapStatsAll(item.diffs), [item.diffs]);
  const parsed = useMemo(
    () => (expanded && hasDiffs ? parsedDiffs(item.id, item.diffs) : NO_PARSED),
    [expanded, hasDiffs, item.id, item.diffs],
  );
  const isCmd = item.toolKind === "execute";

  return (
    <div
      className={cn(
        "overflow-hidden border bg-card/70 transition-colors focus-within:border-line-strong",
        nested ? "rounded-lg" : "rounded-xl",
        expanded ? "border-line-strong" : "border-line hover:border-line-strong",
        item.status === "failed" && "border-err/30",
      )}
    >
      <button
        type="button"
        disabled={!hasBody}
        onClick={() => setOpen(!expanded)}
        aria-expanded={hasBody ? expanded : undefined}
        className={cn(
          "flex w-full items-center gap-2.5 px-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 disabled:cursor-default",
          nested ? "h-8" : "h-9",
        )}
      >
        <span
          className={cn(
            "flex shrink-0 items-center justify-center rounded-md border border-line bg-raised text-steel",
            nested ? "h-5 w-5" : "h-6 w-6",
            running && "border-accent/30 text-accent",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-[12.5px] text-fg/90", isCmd && "font-mono text-[12px]")}>
          {item.title}
        </span>
        {hasDiffs && <DiffStat additions={stats.additions} deletions={stats.deletions} />}
        <ToolStatusIcon status={item.status} stalled={stalled} />
        {hasBody && (
          <ChevronRight
            className={cn("h-3.5 w-3.5 text-steel transition-transform duration-150", expanded && "rotate-90")}
          />
        )}
      </button>
      {running && !expanded && <div className="shimmer-bar h-px bg-accent/10" />}
      <ToolImages item={item} agentId={agentId} />
      <AnimatePresence initial={false}>
        {expanded && hasBody && (
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="border-t border-line"
          >
            {(item.command || item.output) && !hasDiffs && (
              <TerminalOutput command={item.command} output={item.output} live={running} />
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
  const [localReason, setLocalReason] = useState(false);
  // The draft lives in a store so it survives the row being virtualized out of view.
  const reason = usePermissionUi((s) => s.reasonDraft[item.requestId] ?? "");
  const armed = usePermissionUi((s) => Boolean(s.armed[item.requestId]));
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
    if (!keyboard) return null;
    if (keyed.allow?.id === o.id) return "A";
    if (keyed.always?.id === o.id) return "⇧A";
    if (keyed.deny?.id === o.id) return "D";
    return null;
  };
  const shortcutFor = (o: PermissionOption): string | undefined => {
    if (!keyboard) return undefined;
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
      <div className="flex h-9 items-center gap-2.5 rounded-xl border border-line bg-card/50 px-2.5 text-[12.5px]">
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
          className={cn(
            "shrink-0 text-[11.5px] font-medium",
            cancelled ? "text-steel" : allowed ? "text-ok" : "text-err",
          )}
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
      className="relative overflow-hidden rounded-2xl border border-warn/40 bg-gradient-to-b from-warn/[0.09] to-card shadow-[0_0_0_1px_color-mix(in_srgb,var(--warn)_10%,transparent),0_12px_40px_-16px_color-mix(in_srgb,var(--warn)_45%,transparent)] edge"
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-warn/70 to-transparent" />
      <div className="flex items-start gap-3 px-4 pb-3 pt-3.5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-warn/40 bg-warn/15 text-warn">
          <ShieldAlert className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-warn">
            {identity.short} needs your approval
          </div>
          <div
            className={cn(
              "mt-0.5 break-words text-[14px] font-medium text-fg",
              item.toolKind === "execute" && "font-mono text-[13px]",
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
            aria-keyshortcuts={keyboard ? "Shift+D Shift+N" : undefined}
          >
            <MessageSquareX />
            Deny with reason…
            {keyboard && <Kbd className="ml-0.5">⇧D</Kbd>}
          </Button>
        )}
      </div>
      {armed && keyed.always && (
        <div
          role="status"
          className="border-t border-warn/25 bg-warn/[0.12] px-4 py-2 text-[12px] font-medium text-warn"
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
          <label htmlFor={`reason-${item.id}`} className="mb-1.5 block text-[12px] font-medium text-muted">
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
            <span className="mr-auto text-[11px] text-steel">
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

export function PlanChecklist({ entries, dense }: { entries: Item<"plan">["entries"]; dense?: boolean }) {
  return (
    <ul className={cn("space-y-1", dense && "space-y-0.5")}>
      {entries.map((e, i) => (
        <li key={i} className="flex items-start gap-2.5 text-[12.5px] leading-snug">
          <span
            className={cn(
              "mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
              e.status === "completed" && "border-ok/50 bg-ok/15 text-ok",
              e.status === "in_progress" && "border-accent/60 text-accent",
              e.status === "pending" && "border-line-strong",
            )}
          >
            {e.status === "completed" && (
              <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden>
                <path
                  d="M2.5 6.2 5 8.5l4.5-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
            {e.status === "in_progress" && <span className="h-1.5 w-1.5 rounded-full bg-accent animate-breathe" />}
          </span>
          <span
            className={cn(
              e.status === "completed" && "text-steel line-through decoration-line-strong",
              e.status === "in_progress" && "font-medium text-fg",
              e.status === "pending" && "text-muted",
            )}
          >
            {e.content}
          </span>
          {e.priority === "high" && e.status !== "completed" && (
            <span className="ml-auto mt-px shrink-0 rounded px-1 text-[10px] font-medium uppercase tracking-wide text-warn/80">
              high
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export const PlanCard = memo(function PlanCard({ item }: { item: Item<"plan"> }) {
  const done = item.entries.filter((e) => e.status === "completed").length;
  const total = item.entries.length;
  return (
    <div className="rounded-xl border border-line bg-card/70 p-3.5 edge">
      <div className="mb-2.5 flex items-center gap-2">
        <ListChecks className="h-4 w-4 text-accent" />
        <span className="text-[12.5px] font-semibold">Plan</span>
        <span className="text-[11.5px] text-steel tabular">
          {done} of {total}
        </span>
        <div className="ml-auto h-1 w-24 overflow-hidden rounded-full bg-raised">
          <div
            className="h-full origin-left rounded-full bg-accent transition-transform duration-300"
            style={{ transform: `scaleX(${total ? done / total : 0})` }}
          />
        </div>
      </div>
      <PlanChecklist entries={item.entries} />
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
  const recover = item.level === "error" && agent && isLatest;
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
  return (
    <div
      role={item.level === "error" ? "alert" : "status"}
      className={cn(
        "rounded-lg border text-[12.5px]",
        item.level === "error" && "border-err/30 bg-err/[0.07] text-err",
        item.level === "warn" && "border-warn/30 bg-warn/[0.07] text-warn",
        item.level === "info" && "border-line bg-card/40 text-muted",
      )}
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <Icon className="mt-px h-3.5 w-3.5 shrink-0" />
        <span className="selectable">{item.text}</span>
        <RelTime ts={item.ts} className="ml-auto shrink-0 text-[10.5px] opacity-60" />
      </div>
      {recover && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-err/20 px-2 py-1.5">
          {lastPrompt && (
            <Button size="xs" variant="ghost" className="text-fg" disabled={retrying} onClick={() => void retry()}>
              {retrying ? <Spinner className="h-3 w-3" /> : <RotateCcw className="!h-3 !w-3" />}
              {agent.running ? "Retry last message" : "Resume & retry"}
            </Button>
          )}
          {agent.provider !== "custom" && !agent.rateLimited && (
            <Button size="xs" variant="ghost" className="text-fg" onClick={() => useUi.getState().setMoveAgent(agent)}>
              <Repeat className="!h-3 !w-3" />
              Switch account
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
          <img
            src={attachmentSrc(img)}
            alt={img.name}
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
  if (r.bottom > box.bottom - 16) p.scrollBy({ top: r.bottom - box.bottom + 16, behavior: "smooth" });
  else if (r.top < box.top + 16) p.scrollBy({ top: r.top - box.top - 16, behavior: "smooth" });
}
