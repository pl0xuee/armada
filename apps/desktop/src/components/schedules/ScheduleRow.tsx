import { ArrowUpRight, CalendarClock, FolderOpen, GitBranch, Pencil, Play, Trash2 } from "lucide-react";
import { memo } from "react";
import { relativeTimeLong } from "@/lib/format";
import { useIdentity } from "@/hooks/useIdentity";
import { nextRun, scheduleSummary, untilLabel, whenLabel } from "@/lib/schedules";
import type { Account, Agent, Schedule } from "@/lib/types";
import { basename, cn, prettyPath } from "@/lib/utils";
import { AccountAvatar } from "../AccountAvatar";
import { ProviderGlyph } from "../ProviderGlyph";
import { StatusDot } from "../StatusDot";
import { Button } from "../ui/button";
import { Spinner } from "../ui/misc";
import { Switch } from "../ui/switch";
import { Tooltip } from "../ui/tooltip";

export const ScheduleRow = memo(function ScheduleRow({
  schedule,
  account,
  lastAgent,
  now,
  running,
  toggling,
  onToggle,
  onRun,
  onEdit,
  onDelete,
  onOpenAgent,
}: {
  schedule: Schedule;
  account: Account | undefined;
  lastAgent: Agent | undefined;
  now: number;
  running: boolean;
  toggling: boolean;
  onToggle: (enabled: boolean) => void;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenAgent: (id: string) => void;
}) {
  const next = schedule.enabled ? nextRun(schedule, new Date(now)) : null;
  const identity = useIdentity(schedule.provider, schedule.customAgentId);
  const runtime = account ? `${identity.short} · ${account.name}` : identity.name;

  return (
    <li
      className={cn(
        "group relative flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl border bg-card px-4 py-3.5 transition-[border-color,opacity] edge",
        schedule.enabled ? "border-line hover:border-line-strong" : "border-line/70",
      )}
    >
      <div className={cn("flex min-w-[260px] flex-1 items-start gap-3", !schedule.enabled && "opacity-60")}>
        <ProviderGlyph
          provider={schedule.provider}
          customAgentId={schedule.customAgentId}
          size="md"
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={onEdit}
              className="min-w-0 truncate text-left text-[13.5px] font-medium text-fg hover:underline hover:decoration-line-strong hover:underline-offset-4"
            >
              {schedule.name}
            </button>
            <span
              className={cn(
                "hidden h-5 shrink-0 items-center gap-1.5 rounded-full border border-line bg-base/50 pr-2 text-[11px] text-muted xl:inline-flex",
                account ? "pl-0.5" : "pl-2",
              )}
            >
              {account && <AccountAvatar account={account} size={14} showProvider={false} compact />}
              {runtime}
            </span>
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
            <span className="flex items-center gap-1.5 xl:hidden">
              {account && <AccountAvatar account={account} size={14} showProvider={false} compact />}
              {runtime}
            </span>
            <span className="flex items-center gap-1.5">
              <CalendarClock className="h-3.5 w-3.5 text-steel" />
              {scheduleSummary(schedule)}
            </span>
            <Tooltip content={prettyPath(schedule.projectPath)}>
              <span className="flex min-w-0 items-center gap-1.5">
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-steel" />
                <span className="truncate">{basename(schedule.projectPath)}</span>
              </span>
            </Tooltip>
            {schedule.worktree && (
              <Tooltip content="Each run gets its own git worktree">
                <span className="flex items-center text-steel">
                  <GitBranch className="h-3.5 w-3.5" aria-label="Isolated worktree" />
                </span>
              </Tooltip>
            )}
          </div>
          <p className="mt-1.5 line-clamp-1 text-[12px] text-steel" title={schedule.prompt}>
            {schedule.prompt}
          </p>
        </div>
      </div>

      <dl className="grid w-[264px] shrink-0 grid-cols-2 gap-x-4 text-[12px]">
        <div className="min-w-0">
          <dt className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-steel">Next run</dt>
          <dd className="mt-0.5 truncate">
            {next ? (
              <>
                <span className="font-medium text-fg tabular">{whenLabel(next, now)}</span>
                <span className="block text-[11.5px] text-accent tabular">{untilLabel(next, now)}</span>
              </>
            ) : (
              <span className="text-steel">{schedule.enabled ? "Invalid time" : "Paused"}</span>
            )}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-steel">Last run</dt>
          <dd className="mt-0.5 min-w-0">
            {schedule.lastRunAt ? (
              <>
                <span className="block truncate text-fg/90">{relativeTimeLong(schedule.lastRunAt, now)}</span>
                {lastAgent ? (
                  <button
                    type="button"
                    onClick={() => onOpenAgent(lastAgent.id)}
                    className="group/link flex max-w-full items-center gap-1 text-[11.5px] text-muted transition-colors hover:text-accent"
                  >
                    <StatusDot status={lastAgent.status} size={6} />
                    <span className="truncate">Open agent</span>
                    <ArrowUpRight className="h-3 w-3 shrink-0 opacity-60 group-hover/link:opacity-100" />
                  </button>
                ) : (
                  <span className="block text-[11.5px] text-steel">Agent removed</span>
                )}
              </>
            ) : (
              <span className="text-steel">Never</span>
            )}
          </dd>
        </div>
      </dl>

      <div className="flex shrink-0 items-center gap-1.5">
        <Tooltip content={schedule.enabled ? "Pause schedule" : "Enable schedule"}>
          <span className="mr-1.5 flex items-center">
            <Switch
              checked={schedule.enabled}
              disabled={toggling}
              onCheckedChange={onToggle}
              aria-label={`${schedule.enabled ? "Pause" : "Enable"} ${schedule.name}`}
            />
          </span>
        </Tooltip>
        <Button
          size="sm"
          variant="secondary"
          disabled={running}
          onClick={onRun}
          aria-label={`Run ${schedule.name} now`}
        >
          {running ? <Spinner className="h-3.5 w-3.5" /> : <Play className="!h-3.5 !w-3.5" />}
          <span className="hidden xl:inline">Run now</span>
        </Button>
        <Tooltip content="Edit">
          <Button size="icon-sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${schedule.name}`}>
            <Pencil className="!h-3.5 !w-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content="Delete">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onDelete}
            aria-label={`Delete ${schedule.name}`}
            className="hover:text-err"
          >
            <Trash2 className="!h-3.5 !w-3.5" />
          </Button>
        </Tooltip>
      </div>
    </li>
  );
});
