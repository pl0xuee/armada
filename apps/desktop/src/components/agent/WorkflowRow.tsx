import { ChevronUp, CircleCheck, CircleX } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { isSubagentLive } from "@/lib/agents";
import { pluralize } from "@/lib/format";
import type { WorkflowAgent } from "@/lib/types";
import {
  orderAgents,
  parseWorkflowKey,
  recentWorkflowKey,
  summarizeWorkflow,
  useWorkflows,
  watchWorkflow,
  WORKFLOW_LINGER_MS,
  workflowKey,
  type WorkflowCall,
} from "@/lib/workflows";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { formatElapsed } from "../timeline/thinking";
import { useLinger, useRetained } from "./pinnedFold";
import { Elapsed } from "./SubagentStrip";

/**
 * What the pinned workflow row shows: the agent's newest running Workflow run, and for a moment ("Workflow
 * finished") after it ended. Joins the shared poller for the agent's recent runs while the agent is live.
 */
export function useWorkflowPin(agentId: string): { open: boolean; call: WorkflowCall | null } {
  const key = useApp((s) => recentWorkflowKey(s.items[agentId], Date.now()));
  const live = useApp((s) => {
    const a = s.agents[agentId];
    return !!a && isSubagentLive(a.status);
  });
  const calls = useMemo(() => parseWorkflowKey(key), [key]);
  useEffect(() => {
    if (!live) return;
    const leave = calls.map((c) => watchWorkflow(agentId, c.toolCallId));
    return () => leave.forEach((f) => f());
  }, [agentId, calls, live]);

  const runningId = useWorkflows((s) => {
    for (const c of calls)
      if (s.byKey[workflowKey(agentId, c.toolCallId)]?.progress?.state === "running") return c.toolCallId;
    return null;
  });
  const lingering = useLinger(runningId !== null, WORKFLOW_LINGER_MS);
  const shownId = useRetained(runningId);
  const endState = useWorkflows((s) => (shownId ? s.byKey[workflowKey(agentId, shownId)]?.progress?.state : undefined));
  const open = runningId !== null || (lingering && endState === "finished");
  const call = calls.find((c) => c.toolCallId === shownId) ?? null;
  return { open: open && call !== null, call: useRetained(call) };
}

/** Status dot: pulsing while it works (the animation pauses with the window). */
export function WorkflowDot({ status }: { status: WorkflowAgent["status"] }) {
  return (
    <span className="relative flex h-2 w-2 shrink-0 items-center justify-center" aria-hidden>
      {status === "working" && <span className="absolute inset-0 rounded-full bg-accent animate-pulse-ring" />}
      <span
        className={cn(
          "relative h-2 w-2 rounded-full",
          status === "working" && "bg-accent",
          status === "finished" && "bg-ok",
          status === "failed" && "bg-err",
          status === "unknown" && "bg-line-strong",
        )}
      />
    </span>
  );
}

const STATUS_WORD: Record<WorkflowAgent["status"], string> = {
  working: "Working",
  finished: "Done",
  failed: "Failed",
  unknown: "No recent activity",
};

/** One row per agent of a run: status dot, label, latest action, tool calls, time since it last moved. */
export function WorkflowAgentList({ agents, compact }: { agents: readonly WorkflowAgent[]; compact: boolean }) {
  const ordered = useMemo(() => orderAgents(agents), [agents]);
  return (
    <ul className="space-y-px" aria-label="Agents in this workflow">
      {ordered.map((a) => {
        const working = a.status === "working";
        const action = working ? (a.latest ?? "Working") : (a.latest ?? STATUS_WORD[a.status]);
        // Only worth a column once it has been quiet a while (a busy agent changes every few seconds).
        const idle = a.idleSecs !== null && a.idleSecs >= 10 && working ? formatElapsed(a.idleSecs * 1000) : null;
        const calls = pluralize(a.toolCalls, "call");
        return (
          <li
            key={a.id}
            className={cn("rounded-lg px-2", compact ? "py-1" : "flex h-7 items-center gap-2")}
            title={`${a.label}: ${STATUS_WORD[a.status]}`}
          >
            <div className={cn("flex items-center gap-2", compact && "h-4")}>
              <WorkflowDot status={a.status} />
              <span
                className={cn(
                  "min-w-0 truncate text-[12px] font-medium leading-4",
                  compact ? "flex-1" : "w-[136px] shrink-0",
                  !working && "text-muted",
                )}
              >
                {a.label}
              </span>
              {compact && <span className="shrink-0 text-[11.5px] leading-4 text-steel tabular">{calls}</span>}
            </div>
            <div
              className={cn(
                "min-w-0 truncate text-[11.5px] leading-4",
                working ? "text-steel" : "text-steel",
                compact ? "pl-4" : "flex-1",
                a.status === "failed" && "text-err",
              )}
              title={action}
            >
              {action}
            </div>
            {!compact && (
              <>
                <span className="w-[52px] shrink-0 text-right text-[11.5px] leading-4 text-steel tabular">{calls}</span>
                <span
                  className="w-[52px] shrink-0 text-right text-[11.5px] leading-4 text-steel tabular"
                  title={a.idleSecs !== null ? `Last activity ${formatElapsed(a.idleSecs * 1000)} ago` : undefined}
                >
                  {idle ?? ""}
                </span>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The pinned Workflow row: one line (agents working, latest action, elapsed), each agent listed on demand. */
export function WorkflowSection({ agentId, call, compact }: { agentId: string; call: WorkflowCall; compact: boolean }) {
  const progress = useWorkflows((s) => s.byKey[workflowKey(agentId, call.toolCallId)]?.progress ?? null);
  const sum = useMemo(() => summarizeWorkflow(progress), [progress]);
  const [listOpen, setListOpen] = useState(false);
  const finished = progress?.state === "finished";
  const failedAll = finished && sum.total > 0 && sum.failed === sum.total;

  return (
    <section aria-label="Workflow">
      <span role="status" className="sr-only">
        {sum.headline}
      </span>
      <div className={cn("flex items-center", compact ? "h-8" : "h-9")}>
        <button
          type="button"
          onClick={() => useUi.getState().revealItem(agentId, call.itemId)}
          title="Show in conversation"
          className={cn(
            "flex h-full min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:bg-raised/50 focus-visible:outline-offset-[-2px]",
            compact ? "px-3" : "px-3.5",
          )}
        >
          {!finished ? (
            <span className="relative flex h-2 w-2 shrink-0 items-center justify-center" aria-hidden>
              <span className="absolute inset-0 rounded-full bg-accent animate-pulse-ring" />
              <span className="relative h-2 w-2 rounded-full bg-accent" />
            </span>
          ) : failedAll ? (
            <CircleX className="h-3.5 w-3.5 shrink-0 text-err" aria-hidden />
          ) : (
            <CircleCheck className="h-3.5 w-3.5 shrink-0 text-ok" aria-hidden />
          )}
          <span className="min-w-0 truncate text-[12px] font-medium leading-4 text-fg">{sum.headline}</span>
          {!finished && sum.step && !compact && (
            <span className="min-w-0 truncate text-[11.5px] leading-4 text-steel" title={sum.step}>
              <span aria-hidden className="mr-2 text-line-strong">
                ·
              </span>
              {sum.step}
            </span>
          )}
        </button>
        {!finished && (
          <span className="pr-2.5">
            <Elapsed since={call.ts} />
          </span>
        )}
        {sum.total > 0 && (
          <button
            type="button"
            aria-expanded={listOpen}
            aria-label={listOpen ? "Hide the workflow's agents" : "Show each agent of the workflow"}
            title={listOpen ? "Hide list" : "Show each agent"}
            onClick={() => setListOpen((v) => !v)}
            className="flex h-full w-9 shrink-0 items-center justify-center text-steel transition-colors hover:bg-raised/50 hover:text-fg focus-visible:outline-offset-[-2px]"
          >
            <ChevronUp className={cn("h-3.5 w-3.5 transition-transform duration-150", !listOpen && "rotate-180")} />
          </button>
        )}
      </div>
      {listOpen && progress && sum.total > 0 && (
        <div className={cn("overflow-y-auto border-t border-line px-1 py-1", compact ? "max-h-40" : "max-h-48")}>
          <WorkflowAgentList agents={progress.agents} compact={compact} />
        </div>
      )}
    </section>
  );
}
