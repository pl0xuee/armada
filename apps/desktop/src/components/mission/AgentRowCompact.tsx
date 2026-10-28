import { Check, Gauge, ShieldAlert, Workflow, X } from "lucide-react";
import { memo, useState } from "react";
import { ProviderGlyph } from "@/components/ProviderGlyph";
import { RelTime } from "@/components/RelTime";
import { StatusDot } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useIdentity } from "@/hooks/useIdentity";
import { findOption, respondPermission } from "@/lib/actions";
import { agentCostText } from "@/lib/format";
import { DONE_META, STATUS } from "@/lib/providers";
import { useIsDone } from "@/store/completion";
import type { Account, Agent, PermissionOption, TimelineItem } from "@/lib/types";
import { basename, cn } from "@/lib/utils";
import type { TileSummary } from "./useTileSummaries";

type PermissionItem = Extract<TimelineItem, { kind: "permission" }>;

/** Dense, table-like Mission Control row (compact density). */
export const AgentRowCompact = memo(function AgentRowCompact({
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
  const working = agent.status === "working" || agent.status === "starting";
  const allowOpt = pending ? (findOption(pending, ["allow_once"]) ?? findOption(pending, ["allow_always"])) : undefined;
  const denyOpt = pending ? findOption(pending, ["reject_once", "reject_always"]) : undefined;

  const line = pending
    ? pending.title
    : working
      ? (summary.tail ?? summary.action ?? "Working…")
      : (agent.lastMessage ?? summary.action ?? "");

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
      role="listitem"
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
        "group relative grid min-h-11 cursor-default items-center gap-x-3 border-b border-line/70 px-3 py-1.5 transition-colors last:border-b-0 hover:bg-raised/50 focus-visible:bg-raised/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
        "grid-cols-[auto_minmax(0,1fr)_auto] @3xl:grid-cols-[auto_minmax(160px,1.1fr)_minmax(0,1.6fr)_auto]",
        agent.status === "stopped" && "opacity-75",
      )}
    >
      {working && (
        <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-accent shadow-[0_0_8px_var(--accent)]" />
      )}
      <div className="flex items-center gap-2">
        <StatusDot status={agent.status} size={7} done={done} />
        <ProviderGlyph provider={agent.provider} customAgentId={agent.customAgentId} size="sm" />
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn("truncate text-[13px]", agent.unread ? "font-semibold text-fg" : "font-medium text-fg/90")}
          >
            {agent.title}
          </span>
          {agent.unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
          {agent.rateLimited && (
            <Tooltip content="Hit its usage limit">
              <Gauge className="h-3.5 w-3.5 shrink-0 text-warn" aria-label="Usage limit" />
            </Tooltip>
          )}
          {summary.subagents > 0 && (
            <Tooltip content={`${summary.subagents} sub-agent${summary.subagents === 1 ? "" : "s"} running`}>
              <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-accent">
                <Workflow className="h-3 w-3" />
                {summary.subagents}
              </span>
            </Tooltip>
          )}
        </div>
        <div className="truncate text-[11.5px] text-steel">
          {account?.name ?? identity.short} · {basename(agent.projectPath)}
          <span className="@3xl:hidden">
            {line && (
              <>
                {" · "}
                <span className={cn(pending ? "text-warn" : working ? "text-fg/80" : "")}>{line}</span>
              </>
            )}
          </span>
        </div>
      </div>

      <div
        className={cn(
          "hidden min-w-0 items-center gap-1.5 font-mono text-[11.5px] @3xl:flex",
          pending ? "text-warn" : working ? "text-fg/85" : "text-muted",
        )}
      >
        {pending ? (
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
        ) : working ? (
          <span className="h-1 w-1 shrink-0 rounded-full bg-accent animate-breathe" />
        ) : null}
        <span className={cn("truncate", !pending && !working && "font-sans")}>{line}</span>
      </div>

      <div className="flex items-center justify-end gap-2.5">
        {pending ? (
          <div
            className="flex items-center gap-1"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {allowOpt && (
              <Button
                size="xs"
                variant="warn"
                disabled={busy}
                title={allowOpt.name}
                aria-label={`${allowOpt.name}: ${pending.title}`}
                onClick={() => void respond(allowOpt)}
              >
                <Check className="!h-3.5 !w-3.5" />
                <span className="hidden @xl:inline">{allowOpt.kind === "allow_once" ? "Allow" : allowOpt.name}</span>
              </Button>
            )}
            {denyOpt && (
              <Button
                size="xs"
                variant="danger"
                disabled={busy}
                title={denyOpt.name}
                aria-label={`${denyOpt.name}: ${pending.title}`}
                onClick={() => void respond(denyOpt)}
              >
                <X className="!h-3.5 !w-3.5" />
                <span className="hidden @xl:inline">{denyOpt.kind === "reject_once" ? "Deny" : denyOpt.name}</span>
              </Button>
            )}
          </div>
        ) : (
          <span className="hidden w-14 text-right text-[11.5px] tabular text-steel @xl:inline">
            {agentCostText(agent)}
          </span>
        )}
        <span className="w-9 text-right text-[11px] text-steel">
          <RelTime ts={agent.lastActivityAt} />
        </span>
      </div>
    </div>
  );
});
