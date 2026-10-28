import { CalendarClock, Check, Gauge, GitBranch, ShieldAlert, Workflow, X } from "lucide-react";
import { memo, useState } from "react";
import { AccountAvatar } from "@/components/AccountAvatar";
import { ProviderGlyph } from "@/components/ProviderGlyph";
import { useIdentity } from "@/hooks/useIdentity";
import { StatusDot } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { findOption, respondPermission } from "@/lib/actions";
import { RelTime } from "@/components/RelTime";
import { agentCostText, formatTokens } from "@/lib/format";
import { DONE_META, STATUS } from "@/lib/providers";
import { useIsDone } from "@/store/completion";
import type { Account, Agent, PermissionOption, TimelineItem } from "@/lib/types";
import type { TileSummary } from "./useTileSummaries";
import { basename, cn } from "@/lib/utils";

type PermissionItem = Extract<TimelineItem, { kind: "permission" }>;

/** Plain-text preview of markdown, keeping the tail of what's streaming. */
function preview(text: string, tail = false, max = 220): string {
  // Only a window of the (possibly huge, still streaming) message is ever shown: regex just that.
  const window = text.length > 1200 ? (tail ? text.slice(-400) : text.slice(0, 1200)) : text;
  const plain = window
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/[#>*`|]/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/-{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return plain;
  return tail ? `…${plain.slice(plain.length - max)}` : `${plain.slice(0, max)}…`;
}

export const AgentTile = memo(function AgentTile({
  agent,
  account,
  summary,
  pending,
  onOpen,
}: {
  agent: Agent;
  account: Account | undefined;
  summary: TileSummary;
  pending: PermissionItem | null;
  onOpen: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const done = useIsDone(agent);
  const meta = done ? DONE_META : STATUS[agent.status];
  const identity = useIdentity(agent.provider, agent.customAgentId);
  const live = meta.live;
  const working = agent.status === "working" || agent.status === "starting";
  // While working, show what it's doing right now; otherwise the last action it took.
  const tail = working ? summary.tail : null;
  const action = summary.action;
  const streaming = working && Boolean(summary.message) && summary.messageIsTail;
  const message = summary.message
    ? preview(summary.message, streaming)
    : agent.lastMessage
      ? preview(agent.lastMessage)
      : null;
  // "Allow" means allow-once only; when the agent offers no such option, show its real label.
  const allowOpt = pending ? (findOption(pending, ["allow_once"]) ?? findOption(pending, ["allow_always"])) : undefined;
  const denyOpt = pending ? findOption(pending, ["reject_once", "reject_always"]) : undefined;
  const color = meta.colorVar;

  const respond = async (option: PermissionOption | undefined) => {
    if (!pending || !option || busy) return;
    setBusy(true);
    try {
      await respondPermission(agent.id, pending, option);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${agent.title}, ${meta.label}`}
      onClick={() => onOpen(agent.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(agent.id);
        }
      }}
      className={cn(
        "group relative flex h-full min-h-[208px] flex-col overflow-hidden rounded-xl border bg-card transition-[transform,border-color] duration-150 hover:-translate-y-0.5 active:scale-[0.99]",
        live ? "border-transparent" : "border-line hover:border-line-strong",
        agent.status === "stopped" && "opacity-75",
      )}
      style={{
        boxShadow: live
          ? `inset 0 1px 0 var(--edge-strong), 0 0 0 1px color-mix(in srgb, ${color} 38%, var(--border)), 0 10px 36px -14px color-mix(in srgb, ${color} 55%, transparent)`
          : "inset 0 1px 0 var(--edge)",
      }}
    >
      {/* soft status wash */}
      {live && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-24 opacity-70"
          style={{
            background: `radial-gradient(120% 100% at 50% 0%, color-mix(in srgb, ${color} 12%, transparent), transparent 70%)`,
          }}
        />
      )}
      {working && <div aria-hidden className="shimmer-bar absolute inset-x-0 top-0 h-[2px] bg-accent/15" />}

      <div className="relative flex items-center gap-1.5 px-3.5 pt-3">
        <span
          className="flex h-5 shrink-0 items-center gap-1.5 rounded-full border px-1.5 text-[10.5px] font-medium"
          style={{
            color: !done && (agent.status === "idle" || agent.status === "stopped") ? "var(--text-2)" : color,
            borderColor: `color-mix(in srgb, ${color} 30%, var(--border))`,
            background: `color-mix(in srgb, ${color} 8%, transparent)`,
          }}
        >
          <StatusDot status={agent.status} size={6} done={done} />
          {meta.label}
        </span>
        {agent.rateLimited && (
          <span className="flex h-5 shrink-0 items-center gap-1 rounded-full border border-warn/35 bg-warn/10 px-1.5 text-[10.5px] font-medium text-warn">
            <Gauge className="h-3 w-3" />
            Usage limit
          </span>
        )}
        {agent.scheduleId && (
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line text-steel"
            title="Started by a schedule"
            aria-label="Scheduled"
          >
            <CalendarClock className="h-3 w-3" />
          </span>
        )}
        {summary.subagents > 0 && (
          <span className="flex h-5 shrink-0 items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-1.5 text-[10.5px] font-medium text-accent">
            <Workflow className="h-3 w-3" />
            {summary.subagents} sub-agent{summary.subagents === 1 ? "" : "s"}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-steel">
          {agent.unread && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-label="Unread" />}
          <RelTime ts={agent.lastActivityAt} />
        </span>
      </div>

      <div className="relative mt-2.5 flex items-start gap-2.5 px-3.5">
        <ProviderGlyph provider={agent.provider} customAgentId={agent.customAgentId} size="md" className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13.5px] font-medium tracking-[-0.005em] text-fg">{agent.title}</h3>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-steel">
            {account && <AccountAvatar account={account} size={13} showProvider={false} />}
            <span className="shrink-0">{account?.name ?? identity.short}</span>
            <span className="text-line-strong">·</span>
            <span className="truncate">{basename(agent.projectPath)}</span>
            {agent.branch && (
              <span className="flex min-w-0 items-center gap-1">
                <GitBranch className="h-3 w-3 shrink-0" />
                <span className="truncate font-mono text-[10.5px]">{agent.branch.replace(/^armada\//, "")}</span>
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="relative mt-3 flex min-h-0 flex-1 flex-col gap-2 px-3.5">
        {(tail ?? action) && !pending && (
          <div
            className={cn(
              "flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px]",
              tail ? "border-accent/25 bg-accent/[0.06] text-fg/85" : "border-line/70 bg-base/50 text-muted",
            )}
            aria-live={tail ? "off" : undefined}
          >
            <span className={cn("h-1 w-1 shrink-0 rounded-full", working ? "bg-accent animate-breathe" : "bg-steel")} />
            <span className="truncate">{tail ?? action}</span>
          </div>
        )}
        {message ? (
          <p className={cn("line-clamp-3 text-[12.5px] leading-relaxed text-muted", streaming && "caret")}>{message}</p>
        ) : (
          <p className="text-[12.5px] italic text-steel/70">No messages yet</p>
        )}
      </div>

      {pending && (
        <div
          className="relative mx-3 mt-3 rounded-lg border border-warn/35 bg-warn/[0.07] p-2"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-warn">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate font-medium">{pending.title}</span>
          </div>
          <div className="mt-2 flex gap-1.5">
            {allowOpt && (
              <Button
                size="xs"
                variant="warn"
                className="min-w-0 flex-1"
                disabled={busy}
                title={allowOpt.name}
                onClick={() => void respond(allowOpt)}
              >
                <Check className="!h-3.5 !w-3.5" />
                <span className="truncate">{allowOpt.kind === "allow_once" ? "Allow" : allowOpt.name}</span>
              </Button>
            )}
            {denyOpt && (
              <Button
                size="xs"
                variant="danger"
                className="min-w-0 flex-1"
                disabled={busy}
                title={denyOpt.name}
                onClick={() => void respond(denyOpt)}
              >
                <X className="!h-3.5 !w-3.5" />
                <span className="truncate">{denyOpt.kind === "reject_once" ? "Deny" : denyOpt.name}</span>
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="relative mt-3 flex items-center gap-3 border-t border-line/70 px-3.5 py-2 text-[11px] text-steel tabular">
        <span>{agentCostText(agent)}</span>
        <span>{formatTokens(agent.tokensUsed)} tok</span>
        {agent.contextUsed !== null && agent.contextSize ? (
          <span className="flex items-center gap-1.5" title="Context used">
            <span className="relative h-1 w-10 overflow-hidden rounded-full bg-raised">
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-steel"
                style={{ width: `${Math.min(100, (agent.contextUsed / agent.contextSize) * 100)}%` }}
              />
            </span>
            {Math.round((agent.contextUsed / agent.contextSize) * 100)}%
          </span>
        ) : null}
      </div>
    </div>
  );
});
