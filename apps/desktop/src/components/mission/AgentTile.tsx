import { CalendarClock, Check, Gauge, GitBranch, ShieldAlert, X } from "lucide-react";
import { memo, useState } from "react";
import { AccountAvatar } from "@/components/AccountAvatar";
import { ProviderGlyph } from "@/components/ProviderGlyph";
import { useIdentity } from "@/hooks/useIdentity";
import { StatusDot } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { quickRespond } from "@/lib/actions";
import { lastAction } from "@/lib/agents";
import { formatCost, formatTokens, relativeTime } from "@/lib/format";
import { STATUS } from "@/lib/providers";
import type { Account, Agent, TimelineItem } from "@/lib/types";
import { basename, cn } from "@/lib/utils";

type PermissionItem = Extract<TimelineItem, { kind: "permission" }>;

/** Plain-text preview of markdown, keeping the tail of what's streaming. */
function preview(text: string, tail = false, max = 220): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/[#>*`|]/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/-{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return plain;
  return tail ? `…${plain.slice(plain.length - max)}` : `${plain.slice(0, max)}…`;
}

function latestMessage(items: TimelineItem[] | undefined): { text: string; streaming: boolean } | null {
  if (!items) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "agent_message" && it.text.trim()) return { text: it.text, streaming: i === items.length - 1 };
    if (it.kind === "user_message") return null;
  }
  return null;
}

export const AgentTile = memo(function AgentTile({
  agent,
  account,
  items,
  pending,
  now,
  onOpen,
}: {
  agent: Agent;
  account: Account | undefined;
  items: TimelineItem[] | undefined;
  pending: PermissionItem | null;
  now: number;
  onOpen: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const meta = STATUS[agent.status];
  const identity = useIdentity(agent.provider, agent.customAgentId);
  const live = meta.live;
  const working = agent.status === "working" || agent.status === "starting";
  const action = lastAction(items);
  const msg = latestMessage(items);
  const streaming = working && Boolean(msg?.streaming);
  const message = msg ? preview(msg.text, streaming) : agent.lastMessage ? preview(agent.lastMessage) : null;
  const color = meta.colorVar;

  const respond = async (family: "allow_once" | "reject") => {
    if (!pending || busy) return;
    setBusy(true);
    await quickRespond(agent.id, pending, family);
    setBusy(false);
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
            color: agent.status === "idle" || agent.status === "stopped" ? "var(--text-2)" : color,
            borderColor: `color-mix(in srgb, ${color} 30%, var(--border))`,
            background: `color-mix(in srgb, ${color} 8%, transparent)`,
          }}
        >
          <StatusDot status={agent.status} size={6} />
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
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-steel tabular">
          {agent.unread && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-label="Unread" />}
          {relativeTime(agent.lastActivityAt, now)}
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
        {action && !pending && (
          <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-line/70 bg-base/50 px-2 py-1 font-mono text-[11px] text-muted">
            <span className={cn("h-1 w-1 shrink-0 rounded-full", working ? "bg-accent animate-breathe" : "bg-steel")} />
            <span className="truncate">{action}</span>
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
            <Button
              size="xs"
              variant="warn"
              className="flex-1"
              disabled={busy}
              onClick={() => void respond("allow_once")}
            >
              <Check className="!h-3.5 !w-3.5" /> Allow
            </Button>
            <Button
              size="xs"
              variant="danger"
              className="flex-1"
              disabled={busy}
              onClick={() => void respond("reject")}
            >
              <X className="!h-3.5 !w-3.5" /> Deny
            </Button>
          </div>
        </div>
      )}

      <div className="relative mt-3 flex items-center gap-3 border-t border-line/70 px-3.5 py-2 text-[11px] text-steel tabular">
        <span>{formatCost(agent.costUsd)}</span>
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
