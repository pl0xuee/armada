import { ArrowUpRight, Crown, FileCode2 } from "lucide-react";
import { useMemo } from "react";
import { AccountAvatar } from "@/components/AccountAvatar";
import { DiffStat } from "@/components/DiffView";
import { Markdown } from "@/components/Markdown";
import { ProviderGlyph } from "@/components/ProviderGlyph";
import { StatusPill } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { diffStats } from "@/lib/diff";
import { agentCostText, formatTokens, relativeTime } from "@/lib/format";
import { STATUS } from "@/lib/providers";
import { useIsDone } from "@/store/completion";
import { useIdentity } from "@/hooks/useIdentity";
import type { Account, Agent, FileDiff, TimelineItem } from "@/lib/types";
import { cn } from "@/lib/utils";

export function CompareColumn({
  agent,
  account,
  items,
  now,
  cheapest,
  onOpen,
  onKeep,
  keeping,
}: {
  agent: Agent;
  account: Account | undefined;
  items: TimelineItem[] | undefined;
  now: number;
  cheapest: boolean;
  onOpen: () => void;
  onKeep: () => void;
  keeping: boolean;
}) {
  const done = useIsDone(agent);
  const meta = STATUS[agent.status];
  const identity = useIdentity(agent.provider, agent.customAgentId);
  const working = agent.status === "working" || agent.status === "starting";

  const { message, streaming, files, stats } = useMemo(() => {
    let message: string | null = null;
    let streaming = false;
    const diffs: FileDiff[] = [];
    const paths = new Set<string>();
    if (items) {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (message === null && it.kind === "agent_message" && it.text.trim()) {
          message = it.text;
          streaming = i === items.length - 1;
        }
      }
      for (const it of items) {
        if (it.kind === "tool_call") {
          for (const d of it.diffs) {
            diffs.push(d);
            paths.add(d.path);
          }
        }
      }
    }
    return { message, streaming, files: paths.size, stats: diffStats(diffs) };
  }, [items]);

  return (
    <section
      aria-label={`${identity.name} result`}
      className={cn(
        "flex min-h-0 min-w-[320px] flex-1 basis-0 flex-col overflow-hidden rounded-xl border bg-card edge",
        meta.live ? "border-transparent" : "border-line",
      )}
      style={
        meta.live
          ? {
              boxShadow: `inset 0 1px 0 var(--edge-strong), 0 0 0 1px color-mix(in srgb, ${meta.colorVar} 38%, var(--border)), 0 10px 36px -16px color-mix(in srgb, ${meta.colorVar} 50%, transparent)`,
            }
          : undefined
      }
    >
      <header className="relative shrink-0 border-b border-line px-4 py-3">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background: `linear-gradient(180deg, color-mix(in srgb, ${identity.color} 9%, transparent), transparent)`,
          }}
        />
        {working && <div aria-hidden className="shimmer-bar absolute inset-x-0 top-0 h-[2px] bg-accent/15" />}
        <div className="relative flex items-center gap-2.5">
          <ProviderGlyph provider={agent.provider} customAgentId={agent.customAgentId} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold tracking-tight">{identity.name}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-steel">
              {account && <AccountAvatar account={account} size={13} showProvider={false} />}
              <span className="truncate">
                {account?.name ?? (agent.provider === "custom" ? "Custom ACP agent" : "Unknown account")}
              </span>
              <span className="text-line-strong">·</span>
              <span>{relativeTime(agent.lastActivityAt, now)}</span>
            </div>
          </div>
          <StatusPill status={agent.status} done={done} />
        </div>
        <div className="relative mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted tabular">
          <span className={cn("flex items-center gap-1", cheapest && "text-ok")}>
            {agentCostText(agent)}
            {cheapest && <span className="text-[10px] uppercase tracking-wider">cheapest</span>}
          </span>
          <span>{formatTokens(agent.tokensUsed)} tokens</span>
          {files > 0 && (
            <span className="flex items-center gap-1.5">
              <FileCode2 className="h-3 w-3 text-steel" />
              {files} {files === 1 ? "file" : "files"}
              <DiffStat additions={stats.additions} deletions={stats.deletions} />
            </span>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!items ? (
          <div className="space-y-2.5">
            <Skeleton className="w-3/4" />
            <Skeleton className="w-full" />
            <Skeleton className="w-5/6" />
            <Skeleton className="w-2/3" />
          </div>
        ) : message ? (
          <Markdown text={message} streaming={working && streaming} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-10 text-center text-[12.5px] text-steel">
            {working ? (
              <>
                <span className="h-1 w-24 overflow-hidden rounded-full bg-raised shimmer-bar" />
                Thinking…
              </>
            ) : (
              "No response yet"
            )}
          </div>
        )}
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-line bg-panel/50 px-3 py-2.5">
        <Button size="sm" variant="ghost" onClick={onOpen}>
          Open <ArrowUpRight />
        </Button>
        <Button size="sm" variant="primary" className="ml-auto" onClick={onKeep} disabled={keeping}>
          <Crown /> Keep this one
        </Button>
      </footer>
    </section>
  );
}
