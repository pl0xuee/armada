import { ChevronDown, CircleCheck, ListChecks } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  PLAN_LINGER_MS,
  lingerStarts,
  planPhase,
  planProgress,
  planStartsOpen,
  type PlanPhase,
  type PlanProgress,
} from "@/lib/pinned";
import type { TimelineItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { usePinnedUi } from "@/store/pinnedUi";
import { useUi } from "@/store/ui";
import { PlanChecklist } from "../timeline/PlanChecklist";
import { agentDerived } from "./derived";
import { useRetained } from "./pinnedFold";

type PlanItem = Extract<TimelineItem, { kind: "plan" }>;

export interface PlanPin {
  plan: PlanItem;
  progress: PlanProgress;
  phase: PlanPhase;
}

/**
 * The plan to pin, or null. Reads only the memoized, structure-derived plan (see agentDerived), so it
 * re-renders when the plan changes and not per streamed token. An unfinished plan of the current turn
 * is pinned while the agent works; a finished one lingers PLAN_LINGER_MS, then folds away.
 */
export function usePlanPin(agentId: string, busy: boolean): { open: boolean; pin: PlanPin | null } {
  const plan = useApp((s) => agentDerived(agentId, s.items[agentId]).plan);
  const live = useApp((s) => agentDerived(agentId, s.items[agentId]).planLive);
  const progress = useMemo(() => (plan ? planProgress(plan.entries) : null), [plan]);
  const [lingering, setLingering] = useState(false);
  const wasActive = useRef(false);
  const phase = planPhase(progress, { live, busy, lingering });
  const active = planPhase(progress, { live, busy, lingering: false }) === "active";

  useEffect(() => {
    if (active) {
      wasActive.current = true;
      setLingering(false);
      return;
    }
    if (lingerStarts(wasActive.current, phase, progress)) {
      wasActive.current = false;
      setLingering(true);
      const t = setTimeout(() => setLingering(false), PLAN_LINGER_MS);
      return () => clearTimeout(t);
    }
    // Stopped being active without finishing (the turn ended, or a new one began): nothing to linger on.
    if (!progress?.complete) wasActive.current = false;
  }, [active, progress?.complete]);

  // The timeline's plan card stays quiet while this one is pinned.
  const pinned = phase !== null;
  useEffect(() => {
    usePinnedUi.getState().setPlanPinned(agentId, pinned);
    return () => usePinnedUi.getState().setPlanPinned(agentId, false);
  }, [agentId, pinned]);

  const current = useMemo(
    () => (plan && progress && phase ? { plan, progress, phase } : null),
    [plan, progress, phase],
  );
  const pin = useRetained(current);
  return { open: phase !== null, pin };
}

/**
 * The plan's progress, pinned: "Plan · 3 of 5" with a thin bar and the step being worked on; the chevron
 * opens the whole checklist. Compact (a tile): one line. The title jumps to the card in the timeline,
 * which stays the permanent record.
 */
export function PlanSection({ agentId, pin, compact }: { agentId: string; pin: PlanPin; compact: boolean }) {
  const { plan, progress, phase } = pin;
  const saved = usePinnedUi((s) => s.planOpen[agentId]);
  const done = phase === "done";
  const open = !done && !compact && planStartsOpen(progress.total, saved);
  const reveal = () => useUi.getState().revealItem(agentId, plan.id);
  const toggle = () => usePinnedUi.getState().setPlanOpen(agentId, !open);
  const fill = progress.total ? progress.done / progress.total : 0;
  const currentText = progress.current?.content ?? null;
  const label = done ? "Plan complete" : "Plan";

  const bar = (
    <div
      role="progressbar"
      aria-label="Plan progress"
      aria-valuemin={0}
      aria-valuemax={progress.total}
      aria-valuenow={progress.done}
      className={cn("h-1 overflow-hidden rounded-full bg-raised", compact ? "w-14" : "w-24")}
    >
      <div
        className={cn(
          "h-full origin-left rounded-full transition-transform duration-300 motion-reduce:transition-none",
          done ? "bg-ok" : "bg-accent",
        )}
        style={{ transform: `scaleX(${fill})` }}
      />
    </div>
  );
  const count = (
    <span className="shrink-0 text-meta text-steel tabular">
      {compact && !done ? `${progress.done}/${progress.total}` : `${progress.done} of ${progress.total}`}
    </span>
  );

  if (compact) {
    return (
      <section aria-label="Plan" className="px-3 py-1.5">
        <button
          type="button"
          onClick={reveal}
          title="Show the plan in the conversation"
          className="flex h-6 w-full min-w-0 items-center gap-2 rounded text-left focus-visible:outline-offset-2"
        >
          {done ? (
            <CircleCheck className="h-3.5 w-3.5 shrink-0 text-ok" aria-hidden />
          ) : (
            <ListChecks className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
          )}
          {count}
          {bar}
          <span className={cn("min-w-0 truncate text-caption", done ? "text-muted" : "font-medium text-fg")}>
            {done ? "Plan complete" : (currentText ?? "")}
          </span>
        </button>
      </section>
    );
  }

  return (
    <section aria-label="Plan" className="px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={reveal}
          title="Show the plan in the conversation"
          className="-ml-1 flex min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-raised/60 focus-visible:outline-offset-0"
        >
          {done ? (
            <CircleCheck className="h-4 w-4 shrink-0 text-ok" aria-hidden />
          ) : (
            <ListChecks className="h-4 w-4 shrink-0 text-accent" aria-hidden />
          )}
          <span className="text-small font-semibold">{label}</span>
          {count}
        </button>
        <div className="ml-auto flex items-center gap-1.5">
          {bar}
          {!done && (
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              aria-label={open ? "Hide the plan's steps" : "Show all the plan's steps"}
              title={open ? "Hide steps" : "Show all steps"}
              className="flex h-6 w-6 items-center justify-center rounded-md text-steel transition-colors hover:bg-raised hover:text-fg"
            >
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-150", open && "rotate-180")} />
            </button>
          )}
        </div>
      </div>
      {!done && !open && currentText && (
        <div className="mt-1.5 flex items-start gap-2 pl-[1.375rem] text-small leading-snug">
          <span
            aria-hidden
            className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-accent/60"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          </span>
          <span className="min-w-0 truncate font-medium text-fg" title={currentText}>
            {currentText}
          </span>
        </div>
      )}
      {open && (
        <div className="mt-2 max-h-44 overflow-y-auto pl-0.5 pr-1">
          <PlanChecklist entries={plan.entries} dense still />
        </div>
      )}
    </section>
  );
}
