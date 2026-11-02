import { ChevronsDownUp, CircleX, RotateCcw, Wallet } from "lucide-react";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { useIdentity } from "@/hooks/useIdentity";
import { useScrollFade } from "@/hooks/useScrollFade";
import { retryLastPrompt } from "@/lib/actions";
import { isBusy } from "@/lib/agents";
import { formatCost } from "@/lib/format";
import { blockers, dockSections, latestNeedsYou, needsYouKind } from "@/lib/pinned";
import { questionHeadline } from "@/lib/question";
import type { Agent, Attachment } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { Button } from "../ui/button";
import { Spinner } from "../ui/misc";
import { ApprovalSection } from "./ApprovalDock";
import { ConflictBanner } from "./HelperBits";
import { PlanSection, usePlanPin } from "./PinnedPlan";
import { QuestionSection } from "./PinnedQuestion";
import { Fold, useRetained } from "./pinnedFold";
import { QueueStack } from "./QueueStack";
import { RateLimitBanner } from "./RateLimitBanner";
import { SubagentRow, useSubagentPin } from "./SubagentStrip";
import { useWorkflowPin, WorkflowSection } from "./WorkflowRow";

/** The dock never takes more than this share of its pane; past that it scrolls inside. */
const MAX_SHARE = 0.4;
const MIN_MAX_PX = 150;

/** `MAX_SHARE` of the height of the pane (the nearest `[data-pane]`) the element sits in. */
function usePaneShare(ref: React.RefObject<HTMLElement | null>): number | undefined {
  const [max, setMax] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const pane = ref.current?.closest<HTMLElement>("[data-pane]");
    if (!pane) return;
    const measure = () => setMax(Math.max(MIN_MAX_PX, Math.round(pane.clientHeight * MAX_SHARE)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(pane);
    return () => ro.disconnect();
  }, [ref]);
  return max;
}

/**
 * Everything about a conversation that must stay in view while the timeline scrolls, in one place above
 * the composer, most important first:
 *  1. needs you: an approval, a plan to approve, or a question (answerable right here);
 *  2. blocked: the usage limit, an error, a reached budget, a helper's merge conflict (each with its action);
 *  3. the plan's progress; 4. a running Workflow; 5. running sub-agents; 6. queued messages.
 * Sections fold in and out (~200 ms); the whole dock is capped at 40% of the pane and scrolls inside.
 * It reads only memoized, structure-derived data, so it doesn't re-render per streamed token.
 */
export const PinnedDock = memo(function PinnedDock({
  agent,
  focused,
  compact,
  resumable,
  onEditQueued,
}: {
  agent: Agent;
  focused: boolean;
  compact: boolean;
  /** Stopped or interrupted: the Resume banner replaces the composer, so nothing waits for an answer. */
  resumable: boolean;
  onEditQueued: (text: string, attachments: Attachment[]) => void;
}) {
  const identity = useIdentity(agent.provider, agent.customAgentId);
  const blocked = agent.status === "needs_permission" && !resumable;
  // Only scanned while the agent actually waits; returns the (stable) timeline item.
  const needs = useApp((s) => (blocked ? latestNeedsYou(s.items[agent.id]) : null));
  const cap = useApp((s) => s.settings?.agentBudgetUsd);
  const budgetAction = useApp((s) => s.settings?.budgetAction);
  const block = blockers(agent, { agentBudgetUsd: cap, budgetAction });
  const planPin = usePlanPin(agent.id, isBusy(agent));
  const sub = useSubagentPin(agent.id);
  const workflow = useWorkflowPin(agent.id);
  const queued = agent.queue.length > 0;

  const keptNeeds = useRetained(needs);
  const kind = needsYouKind(needs);
  const sections = dockSections({
    needs_you: needs !== null,
    rate_limit: block.rateLimit,
    error: block.error,
    budget: block.budget,
    conflict: block.conflict,
    plan: planPin.open,
    workflow: workflow.open,
    subagents: sub.open,
    queue: queued,
  });
  const any = sections.length > 0;
  const urgent = kind !== null;
  const stuck = block.rateLimit || block.error || block.budget || block.conflict;

  const anchor = useRef<HTMLDivElement>(null);
  const maxHeight = usePaneShare(anchor);

  // Said once when something starts waiting for you (the region exists before its text changes).
  const announcement =
    needs?.kind === "question"
      ? `${identity.short} has a question: ${questionHeadline(needs)}`
      : kind === "plan_approval"
        ? `${identity.short} has a plan for you to approve`
        : needs?.kind === "permission"
          ? `${identity.short} needs your approval: ${needs.title}`
          : "";

  return (
    <>
      <div ref={anchor} role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      <Fold open={any}>
        <div className="pb-2">
          <section
            role="region"
            // The title tells the docks of side-by-side agents apart.
            aria-label={`Pinned for ${agent.title}: what needs you, and progress`}
            className={cn(
              "overflow-hidden rounded-2xl border bg-card/90 transition-colors duration-200 edge",
              urgent
                ? "border-warn/40"
                : block.error || block.budget
                  ? "border-err/30"
                  : stuck
                    ? "border-warn/30"
                    : "border-line-strong",
            )}
          >
            <DockScroller maxHeight={maxHeight}>
              <Fold open={needs !== null}>
                {keptNeeds && (
                  <div className="bg-gradient-to-b from-warn/[0.09] to-transparent">
                    {keptNeeds.kind === "question" ? (
                      <QuestionSection
                        key={keptNeeds.requestId}
                        agent={agent}
                        item={keptNeeds}
                        focused={focused}
                        compact={compact}
                      />
                    ) : keptNeeds.kind === "permission" ? (
                      <ApprovalSection key={keptNeeds.requestId} agent={agent} item={keptNeeds} focused={focused} />
                    ) : null}
                  </div>
                )}
              </Fold>
              <Fold open={block.rateLimit}>
                <RateLimitBanner agent={agent} embedded />
              </Fold>
              <Fold open={block.error}>
                <ErrorRow agent={agent} />
              </Fold>
              <Fold open={block.budget}>
                <BudgetRow agent={agent} cap={cap} />
              </Fold>
              <Fold open={block.conflict}>
                <ConflictBanner agent={agent} embedded />
              </Fold>
              <Fold open={planPin.open}>
                {planPin.pin && <PlanSection agentId={agent.id} pin={planPin.pin} compact={compact} />}
              </Fold>
              <Fold open={workflow.open}>
                {workflow.call && <WorkflowSection agentId={agent.id} call={workflow.call} compact={compact} />}
              </Fold>
              <Fold open={sub.open}>
                {sub.strip && <SubagentRow agentId={agent.id} runs={sub.runs} strip={sub.strip} compact={compact} />}
              </Fold>
              <Fold open={queued}>
                <QueueStack agent={agent} onEdit={onEditQueued} embedded />
              </Fold>
            </DockScroller>
          </section>
        </div>
      </Fold>
    </>
  );
});

/** The dock's scroller: soft edges when its sections outgrow the share of the pane it may take. */
function DockScroller({ maxHeight, children }: { maxHeight: number | undefined; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollFade(ref, 10);
  return (
    <div
      ref={ref}
      className="scroll-fade divide-y divide-line overflow-y-auto overscroll-contain"
      style={maxHeight ? { maxHeight } : undefined}
    >
      {children}
    </div>
  );
}

/** The turn failed: what the provider said, with Retry. (A usage limit has its own row.) */
function ErrorRow({ agent }: { agent: Agent }) {
  const identity = useIdentity(agent.provider, agent.customAgentId);
  // The newest error of this turn, and the message to send again.
  const notice = useApp((s) => {
    const list = s.items[agent.id];
    for (let i = (list?.length ?? 0) - 1; i >= 0; i--) {
      const it = list![i];
      if (it.kind === "notice" && it.level === "error") return it;
      if (it.kind === "user_message") return null;
    }
    return null;
  });
  const lastPrompt = useApp((s) => s.items[agent.id]?.findLast((i) => i.kind === "user_message"));
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    if (lastPrompt?.kind !== "user_message" || busy) return;
    setBusy(true);
    await retryLastPrompt(agent, lastPrompt);
    setBusy(false);
  };
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-err/35 bg-err/10 text-err">
        <CircleX className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-[160px] flex-1">
        <div className="text-[13px] font-semibold">{identity.short} stopped with an error</div>
        {notice && <div className="selectable line-clamp-2 text-[12px] leading-snug text-muted">{notice.text}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {lastPrompt?.kind === "user_message" && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void retry()}>
            {busy ? <Spinner className="h-3.5 w-3.5 text-current" /> : <RotateCcw />}
            {agent.running ? "Retry" : "Resume & retry"}
          </Button>
        )}
        {notice && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Show the error in the conversation"
            title="Show in conversation"
            onClick={() => useUi.getState().revealItem(agent.id, notice.id)}
          >
            <ChevronsDownUp />
          </Button>
        )}
      </div>
    </div>
  );
}

/** The agent reached its budget and the setting pauses agents: raise it to go on. */
function BudgetRow({ agent, cap }: { agent: Agent; cap: number | null | undefined }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-err/35 bg-err/10 text-err">
        <Wallet className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-[160px] flex-1">
        <div className="text-[13px] font-semibold">Budget reached</div>
        <div className="text-[12px] leading-snug text-muted">
          <span className="tabular">
            {formatCost(agent.costUsd)} of {cap != null ? formatCost(cap) : "its cap"}
          </span>
          . This agent is paused; raise the budget to keep going.
        </div>
      </div>
      <Button size="sm" variant="secondary" onClick={() => useUi.getState().openSettings("budgets")}>
        Open budgets
      </Button>
    </div>
  );
}
