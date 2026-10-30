import {
  Archive,
  ArrowUpRight,
  CircleCheck,
  CircleX,
  Gauge,
  Play,
  Repeat,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
} from "lucide-react";
import { useMemo, useState } from "react";
import { AccountAvatar } from "@/components/AccountAvatar";
import { FileDiffView } from "@/components/DiffView";
import { Markdown } from "@/components/Markdown";
import { ProviderGlyph } from "@/components/ProviderGlyph";
import { RelTime } from "@/components/RelTime";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { useIdentity } from "@/hooks/useIdentity";
import { CONTINUE_PROMPT, attempt, findOption, respondPermission, resumeAgent } from "@/lib/actions";
import { api } from "@/lib/api";
import { parseFileDiff } from "@/lib/diff";
import { formatCost, formatTokens } from "@/lib/format";
import type { PermissionOption, TimelineItem } from "@/lib/types";
import { basename, cn } from "@/lib/utils";
import { useApp, usePendingPermissions, usePendingQuestions } from "@/store/app";
import { QuestionCard } from "@/components/timeline/QuestionCard";
import { useUi } from "@/store/ui";
import { REASON_TONE, reasonLabel, type TriageEntry } from "./useTriage";
import { CodeText } from "../CodeText";

type Permission = Extract<TimelineItem, { kind: "permission" }>;

function lastOf<K extends TimelineItem["kind"]>(items: TimelineItem[] | undefined, kind: K) {
  if (!items) return undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === kind) return it as Extract<TimelineItem, { kind: K }>;
  }
  return undefined;
}

function lastErrorText(items: TimelineItem[] | undefined): string | null {
  if (!items) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "notice" && it.level === "error") return it.text;
  }
  return null;
}

/** Sort permission options: allow once, allow always, then rejections. */
const OPTION_ORDER: Record<PermissionOption["kind"], number> = {
  allow_once: 0,
  allow_always: 1,
  reject_once: 2,
  reject_always: 3,
};

export function TriageDetail({
  entry,
  onDone,
  onArchive,
  alwaysArmed = false,
}: {
  entry: TriageEntry;
  onDone: () => void;
  onArchive: () => void;
  /** Shift+A was pressed once: the next Shift+A always-allows. */
  alwaysArmed?: boolean;
}) {
  const { agent, reason } = entry;
  const identity = useIdentity(agent.provider, agent.customAgentId);
  const account = useApp((s) => s.accounts.find((a) => a.id === agent.accountId));
  const items = useApp((s) => s.items[agent.id]);
  const loading = useApp((s) => s.itemsLoading[agent.id] ?? false);
  const pending = usePendingPermissions().find((p) => p.agent.id === agent.id)?.item;
  const question = usePendingQuestions().find((p) => p.agent.id === agent.id)?.item;
  const openAgent = useUi((s) => s.openAgent);
  const label = reasonLabel(reason, !pending && !!question);

  return (
    <article data-agent-id={agent.id} aria-label={`${agent.title}: ${label}`} className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-start gap-3 border-b border-line px-5 py-4">
        <ProviderGlyph provider={agent.provider} customAgentId={agent.customAgentId} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", REASON_TONE[reason])}>
              {label}
            </span>
            <span className="text-[11.5px] text-steel">
              <RelTime ts={agent.lastActivityAt} long />
            </span>
          </div>
          <h2 className="mt-1 line-clamp-2 text-[17px] font-semibold leading-snug tracking-[-0.015em]">
            {agent.title}
          </h2>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-steel">
            {account ? (
              <>
                <AccountAvatar account={account} size={14} showProvider={false} />
                <span className="truncate">
                  {identity.short} · {account.name}
                </span>
              </>
            ) : (
              <span>{identity.name}</span>
            )}
            <span className="text-line-strong">·</span>
            <span className="truncate">{basename(agent.projectPath)}</span>
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {!items && loading ? (
          <div className="space-y-2.5" aria-label="Loading">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
            <Skeleton className="h-24 w-full rounded-xl" />
          </div>
        ) : reason === "permission" ? (
          pending ? (
            <PermissionPanel agentId={agent.id} item={pending} provider={identity.short} alwaysArmed={alwaysArmed} />
          ) : question ? (
            <QuestionCard item={question} agent={agent} compact />
          ) : (
            <p className="text-[13px] text-muted">The request was answered elsewhere. Mark this done to move on.</p>
          )
        ) : reason === "rate_limited" ? (
          <RecoveryPanel
            tone="warn"
            icon={<Gauge className="h-4 w-4" />}
            title="This account hit its usage limit"
            text={lastOf(items, "notice")?.text ?? `${identity.short} paused until the limit resets.`}
            actions={
              <>
                <Button size="sm" variant="warn" onClick={() => useUi.getState().setMoveAgent(agent)}>
                  <Repeat className="!h-3.5 !w-3.5" /> Switch account…
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void attempt("Couldn't send", () => api.sendPrompt(agent.id, CONTINUE_PROMPT))}
                >
                  <RotateCcw className="!h-3.5 !w-3.5" /> Retry now
                </Button>
              </>
            }
          />
        ) : reason === "error" ? (
          <RecoveryPanel
            tone="err"
            icon={<CircleX className="h-4 w-4" />}
            title="The last turn failed"
            text={lastErrorText(items) ?? agent.lastMessage ?? "Something went wrong."}
            actions={
              <>
                {agent.running ? (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void attempt("Couldn't send", () => api.sendPrompt(agent.id, CONTINUE_PROMPT))}
                  >
                    <RotateCcw className="!h-3.5 !w-3.5" /> Retry
                  </Button>
                ) : (
                  <Button size="sm" variant="primary" onClick={() => void resumeAgent(agent)}>
                    <Play className="!h-3.5 !w-3.5" /> Resume
                  </Button>
                )}
                {agent.provider !== "custom" && (
                  <Button size="sm" variant="secondary" onClick={() => useUi.getState().setMoveAgent(agent)}>
                    <Repeat className="!h-3.5 !w-3.5" /> Switch account…
                  </Button>
                )}
              </>
            }
          />
        ) : (
          <DonePanel items={items} fallback={agent.lastMessage} agentId={agent.id} />
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-line bg-panel/50 px-5 py-3">
        <Button size="sm" variant="secondary" onClick={() => openAgent(agent.id)}>
          <ArrowUpRight className="!h-3.5 !w-3.5" /> Open
          <Kbd className="ml-1 hidden @2xl:inline-flex">⏎</Kbd>
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onArchive}>
            <Archive className="!h-3.5 !w-3.5" /> Archive
            <span className="ml-1 hidden gap-0.5 @2xl:flex">
              <Kbd>⇧</Kbd>
              <Kbd>E</Kbd>
            </span>
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={onDone}
            // An approval is still blocking the agent: answer it rather than marking it done.
            aria-disabled={reason === "permission" || undefined}
            title={
              reason === "permission"
                ? question && !pending
                  ? "Answer the question first"
                  : "Answer the approval first (A / D)"
                : undefined
            }
            className={cn(reason === "permission" && "cursor-not-allowed opacity-45")}
          >
            <CircleCheck className="!h-3.5 !w-3.5" /> Done
            <Kbd className="ml-1 hidden border-accent-fg/30 bg-transparent text-accent-fg/80 @2xl:inline-flex">E</Kbd>
          </Button>
        </div>
      </footer>
    </article>
  );
}

function PermissionPanel({
  agentId,
  item,
  provider,
  alwaysArmed,
}: {
  agentId: string;
  item: Permission;
  provider: string;
  alwaysArmed: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => item.diffs.flatMap(parseFileDiff), [item.diffs]);
  const options = useMemo(
    () => [...item.options].sort((a, b) => OPTION_ORDER[a.kind] - OPTION_ORDER[b.kind]),
    [item.options],
  );
  const once = findOption(item, ["allow_once"]);
  const always = findOption(item, ["allow_always"]);
  const deny = findOption(item, ["reject_once", "reject_always"]);
  const answer = async (o: PermissionOption) => {
    if (busy) return;
    setBusy(true);
    try {
      await respondPermission(agentId, item, o);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-warn/40 bg-warn/15 text-warn">
          <ShieldAlert className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-warn">{provider} wants to</p>
          <p
            className={cn(
              "break-words text-[14px] font-medium",
              item.toolKind === "execute" && "font-mono text-[13px]",
            )}
          >
            {item.title}
          </p>
        </div>
      </div>
      {item.command && (
        <pre className="selectable overflow-x-auto rounded-xl border border-line bg-code px-3.5 py-2.5 font-mono text-[12px] text-fg/90">
          <span className="select-none text-accent">❯ </span>
          <CodeText code={item.command} lang="shellscript" />
        </pre>
      )}
      {parsed.map((f, i) => (
        <FileDiffView key={i} file={f} maxHeight={260} />
      ))}
      {alwaysArmed && always && (
        <p role="status" className="rounded-lg border border-warn/35 bg-warn/10 px-3 py-2 text-[12px] text-warn">
          Press <Kbd>⇧</Kbd>
          <Kbd>A</Kbd> again to always allow “{always.name}”. This can't be undone from here.
        </p>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        {options.map((o) => {
          const allow = o.kind.startsWith("allow");
          return (
            <Button
              key={o.id}
              size="sm"
              disabled={busy}
              variant={o.kind === "allow_once" ? "warn" : allow ? "secondary" : "danger"}
              onClick={() => void answer(o)}
            >
              {allow ? <ShieldCheck className="!h-3.5 !w-3.5" /> : <ShieldX className="!h-3.5 !w-3.5" />}
              {o.name}
              {o === once && <Kbd className="ml-1 border-warn-fg/30 bg-transparent text-warn-fg/80">A</Kbd>}
              {o === always && (
                <span className="ml-1 flex gap-0.5">
                  <Kbd className="bg-transparent">⇧</Kbd>
                  <Kbd className="bg-transparent">A</Kbd>
                </span>
              )}
              {o === deny && <Kbd className="ml-1 bg-transparent">D</Kbd>}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function RecoveryPanel({
  tone,
  icon,
  title,
  text,
  actions,
}: {
  tone: "warn" | "err";
  icon: React.ReactNode;
  title: string;
  text: string;
  actions: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        tone === "warn" ? "border-warn/35 bg-warn/[0.06]" : "border-err/30 bg-err/[0.06]",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border",
            tone === "warn" ? "border-warn/40 bg-warn/15 text-warn" : "border-err/40 bg-err/15 text-err",
          )}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold">{title}</p>
          <p className="selectable mt-0.5 break-words text-[12.5px] leading-relaxed text-muted">{text}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 pl-[38px]">{actions}</div>
    </div>
  );
}

function DonePanel({
  items,
  fallback,
  agentId,
}: {
  items: TimelineItem[] | undefined;
  fallback: string | null;
  agentId: string;
}) {
  // A reply that is only a picture has no text to show here.
  const message = [...(items ?? [])].reverse().find((i) => i.kind === "agent_message" && i.text.trim()) as
    Extract<TimelineItem, { kind: "agent_message" }> | undefined;
  const summary = lastOf(items, "turn_summary");
  return (
    <div className="space-y-3">
      {summary && (
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-steel tabular">
          <span>{formatDuration(summary.durationMs)}</span>
          <span>
            {summary.files.length} file{summary.files.length === 1 ? "" : "s"} changed
          </span>
          <span>{summary.commands} commands</span>
          <span>{formatCost(summary.costUsd)}</span>
          <span>{formatTokens(summary.tokens)} tokens</span>
        </p>
      )}
      {message?.text ? (
        <Markdown text={message.text} agentId={agentId} />
      ) : fallback ? (
        <p className="text-[13px] leading-relaxed text-muted">{fallback}</p>
      ) : (
        <p className="text-[13px] text-steel">The agent finished without a message.</p>
      )}
    </div>
  );
}

/** "42s", "6m 42s", "1h 05m". */
function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
