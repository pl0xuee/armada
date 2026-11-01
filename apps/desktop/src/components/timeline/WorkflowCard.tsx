import { ChevronRight, CircleCheck, CircleX, Workflow } from "lucide-react";
import { memo, useEffect, useId, useMemo, useState } from "react";
import type { TimelineItem } from "@/lib/types";
import { pluralize } from "@/lib/format";
import {
  summarizeWorkflow,
  useWorkflows,
  watchWorkflow,
  WORKFLOW_WATCH_MAX_AGE_MS,
  workflowKey,
} from "@/lib/workflows";
import { cn } from "@/lib/utils";
import { WorkflowAgentList } from "../agent/WorkflowRow";
import { Spinner } from "../ui/misc";

type ToolItem = Extract<TimelineItem, { kind: "tool_call" }>;

/**
 * A Claude Workflow launch (several agents in parallel, each in its own worktree) at the tool call's place in
 * the conversation: the summary, then one line of progress that opens into one row per agent.
 */
export const WorkflowCard = memo(function WorkflowCard({ item, agentId }: { item: ToolItem; agentId: string }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const watchable = Date.now() - item.ts < WORKFLOW_WATCH_MAX_AGE_MS;
  useEffect(
    () => (watchable ? watchWorkflow(agentId, item.toolCallId) : undefined),
    [agentId, item.toolCallId, watchable],
  );
  const entry = useWorkflows((s) => s.byKey[workflowKey(agentId, item.toolCallId)]);
  const progress = entry?.progress ?? null;
  const sum = useMemo(() => summarizeWorkflow(progress), [progress]);
  const info = item.subagent;
  const summary = info?.description?.trim() || "Workflow";
  const running = sum.active;
  const done = progress?.state === "finished";
  const failedAll = done && sum.total > 0 && sum.failed === sum.total;

  const status = !progress
    ? entry?.failed
      ? "Progress isn't available"
      : watchable
        ? "Checking progress…"
        : "Started in the background"
    : done
      ? `${pluralize(sum.total, "agent")} finished${sum.failed ? `, ${sum.failed} failed` : ""} · ${pluralize(sum.calls, "tool call")}`
      : sum.working > 0
        ? `${sum.working} of ${pluralize(sum.total, "agent")} working · ${pluralize(sum.calls, "tool call")}`
        : running
          ? "Starting or wrapping up…"
          : `${pluralize(sum.total, "agent")} · no recent activity`;

  return (
    <section
      aria-label={`Workflow: ${summary}`}
      className={cn(
        "relative overflow-hidden rounded-xl border bg-card/50",
        running ? "border-accent/30" : failedAll ? "border-err/30" : "border-line",
      )}
    >
      {running && <div aria-hidden className="shimmer-bar absolute inset-x-0 top-0 h-px" />}
      <header className="flex items-start gap-2.5 px-3 pb-2 pt-2.5">
        <span
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border",
            running ? "border-accent/40 bg-accent/10 text-accent" : "border-line-strong bg-raised text-steel",
          )}
        >
          <Workflow className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-flex h-5 items-center rounded-md border border-violet/30 bg-violet/10 px-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-violet">
              Workflow
            </span>
            {running && <span className="text-[11.5px] leading-4 text-accent">Running in background</span>}
          </div>
          <p className="mt-1 break-words text-[13px] font-medium leading-snug text-fg">{summary}</p>
        </div>
        <span className="mt-1 shrink-0" aria-live="off">
          {running ? (
            <Spinner className="h-4 w-4" />
          ) : failedAll ? (
            <CircleX className="h-4 w-4 text-err" aria-label="Failed" />
          ) : done ? (
            <CircleCheck className="h-4 w-4 text-ok/80" aria-label="Finished" />
          ) : null}
        </span>
      </header>
      <button
        type="button"
        disabled={sum.total === 0}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-full items-center gap-1.5 border-t border-line px-3 text-left text-[11.5px] leading-4 text-muted transition-colors enabled:hover:bg-raised/40 enabled:hover:text-fg"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 transition-transform duration-150",
            open && "rotate-90",
            sum.total === 0 && "opacity-0",
          )}
        />
        <span className="min-w-0 truncate tabular">{status}</span>
      </button>
      {open && progress && (
        <div id={listId} className="border-t border-line px-1 py-1">
          <WorkflowAgentList agents={progress.agents} compact />
        </div>
      )}
    </section>
  );
});
