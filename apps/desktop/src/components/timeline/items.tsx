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
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { respondPermission } from "@/lib/actions";
import { parseFileDiff } from "@/lib/diff";
import { clockTime } from "@/lib/format";
import type { Agent, PermissionOption, TimelineItem, ToolKind } from "@/lib/types";
import { cn } from "@/lib/utils";
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
        <div className="mt-1 text-right text-[10.5px] text-steel opacity-0 transition-opacity group-hover:opacity-100">
          {clockTime(item.ts)}
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
          <span className="text-[10.5px] text-steel">{clockTime(item.ts)}</span>
        </div>
      )}
      {item.text ? (
        <Markdown text={item.text} streaming={streaming} />
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
        <div className="mt-1 flex opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton text={item.text} className="-ml-1.5" />
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------- thought

export const ThoughtBlock = memo(function ThoughtBlock({ item, live }: { item: Item<"thought">; live: boolean }) {
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
          <motion.div
            initial={{ opacity: 0, y: -2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            className="ml-[7px] mt-1 border-l border-line-strong pl-3.5"
          >
            <Markdown
              text={item.text || "…"}
              className="!text-[12.5px] italic !leading-relaxed text-muted [&_*]:!text-muted"
            />
          </motion.div>
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
  useEffect(() => {
    const el = ref.current;
    if (el && live) el.scrollTop = el.scrollHeight;
  }, [output, live]);
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  return (
    <div className="group/term relative bg-code">
      {(command || text) && (
        <div className="absolute right-1.5 top-1.5 z-[1] opacity-0 transition-opacity group-hover/term:opacity-100">
          <CopyButton text={command ? `${command}\n${text}` : text} />
        </div>
      )}
      <pre
        ref={ref}
        className="selectable overflow-auto px-3.5 py-2.5 font-mono text-[12px] leading-[1.6] text-fg/85"
        style={{ maxHeight }}
      >
        {command && (
          <div className="mb-1 text-fg">
            <span className="select-none text-accent">❯ </span>
            {command}
          </div>
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
  agentLive = true,
}: {
  item: Item<"tool_call">;
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
  const parsed = useMemo(() => item.diffs.flatMap(parseFileDiff), [item.diffs]);
  const stats = useMemo(
    () => parsed.reduce((acc, f) => ({ a: acc.a + f.additions, d: acc.d + f.deletions }), { a: 0, d: 0 }),
    [parsed],
  );
  const isCmd = item.toolKind === "execute";

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-card/70 transition-colors",
        expanded ? "border-line-strong" : "border-line hover:border-line-strong",
        item.status === "failed" && "border-err/30",
      )}
    >
      <button
        type="button"
        disabled={!hasBody}
        onClick={() => setOpen(!expanded)}
        aria-expanded={hasBody ? expanded : undefined}
        className="flex h-9 w-full items-center gap-2.5 px-2.5 text-left disabled:cursor-default"
      >
        <span
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line bg-raised text-steel",
            running && "border-accent/30 text-accent",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-[12.5px] text-fg/90", isCmd && "font-mono text-[12px]")}>
          {item.title}
        </span>
        {parsed.length > 0 && <DiffStat additions={stats.a} deletions={stats.d} />}
        <ToolStatusIcon status={item.status} stalled={stalled} />
        {hasBody && (
          <ChevronRight
            className={cn("h-3.5 w-3.5 text-steel transition-transform duration-150", expanded && "rotate-90")}
          />
        )}
      </button>
      {running && !expanded && <div className="shimmer-bar h-px bg-accent/10" />}
      <AnimatePresence initial={false}>
        {expanded && hasBody && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="border-t border-line"
          >
            {(item.command || item.output) && parsed.length === 0 && (
              <TerminalOutput command={item.command} output={item.output} live={running} />
            )}
            {parsed.length > 0 && (
              <div className="divide-y divide-line">
                {parsed.map((f, i) => (
                  <FileDiffView key={i} file={f} flush maxHeight={360} />
                ))}
              </div>
            )}
          </motion.div>
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
}: {
  item: Item<"permission">;
  agent: Agent;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const identity = useIdentity(agent.provider, agent.customAgentId);
  const parsed = useMemo(() => item.diffs.flatMap(parseFileDiff), [item.diffs]);
  const resolved = item.resolution !== null;
  const chosen = item.options.find((o) => o.id === item.resolution);

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
    setBusy(o.id);
    await respondPermission(agent.id, item, o);
    setBusy(null);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
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
      <div className="flex flex-wrap gap-2 border-t border-warn/15 bg-base/30 px-4 py-3">
        {item.options.map((o, i) => {
          const allow = o.kind.startsWith("allow");
          return (
            <Button
              key={o.id}
              size="sm"
              disabled={busy !== null}
              variant={allow ? (i === 0 ? "warn" : "secondary") : "danger"}
              onClick={() => void answer(o)}
              className={cn(o.kind === "reject_once" || o.kind === "reject_always" ? "sm:ml-auto" : "")}
            >
              {busy === o.id ? <Spinner className="h-3.5 w-3.5 text-current" /> : null}
              {o.name}
            </Button>
          );
        })}
      </div>
    </motion.div>
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

export const NoticeBanner = memo(function NoticeBanner({ item }: { item: Item<"notice"> }) {
  const Icon = item.level === "error" ? CircleX : item.level === "warn" ? TriangleAlert : Info;
  return (
    <div
      role={item.level === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px]",
        item.level === "error" && "border-err/30 bg-err/[0.07] text-err",
        item.level === "warn" && "border-warn/30 bg-warn/[0.07] text-warn",
        item.level === "info" && "border-line bg-card/40 text-muted",
      )}
    >
      <Icon className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="selectable">{item.text}</span>
      <span className="ml-auto shrink-0 text-[10.5px] opacity-60">{clockTime(item.ts)}</span>
    </div>
  );
});
