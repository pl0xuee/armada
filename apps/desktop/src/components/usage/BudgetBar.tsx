import { Wallet } from "lucide-react";
import { budgetFill, budgetPercent } from "@/lib/budget";
import { formatCost } from "@/lib/format";
import type { BudgetStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const FILL = { under: "bg-accent", warn: "bg-warn", hit: "bg-err" } as const;
const TEXT = { under: "text-muted", warn: "text-warn", hit: "text-err" } as const;

/** Today's spend against the daily budget: a compact progress bar. */
export function BudgetBar({ status, onConfigure }: { status: BudgetStatus; onConfigure: () => void }) {
  const cap = status.dailyBudgetUsd;
  if (cap == null) return null;
  const pct = budgetPercent(status.todayUsd, cap) ?? 0;
  return (
    <div className="rounded-xl border border-line bg-card px-4 py-3 edge">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-steel [&_svg]:h-3.5 [&_svg]:w-3.5">
          <Wallet />
          Today&rsquo;s budget
        </div>
        <div className="flex items-baseline gap-2 text-[12.5px] tabular">
          <span className="font-medium text-fg">{formatCost(status.todayUsd)}</span>
          <span className="text-steel">of {formatCost(cap)}</span>
          <span className={cn("w-9 text-right font-medium", TEXT[status.level])}>{pct}%</span>
        </div>
      </div>
      <div
        role="progressbar"
        aria-label="Today's spend against the daily budget"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, pct)}
        className="mt-2 h-1.5 overflow-hidden rounded-[4px] bg-raised/70"
      >
        <div
          className={cn("h-full rounded-[4px] transition-[width] duration-300", FILL[status.level])}
          style={{ width: `${budgetFill(status.todayUsd, cap)}%` }}
        />
      </div>
      <div className="mt-1.5 text-[11.5px] text-steel">
        Since midnight, all agents.{" "}
        <button
          type="button"
          className="text-muted underline-offset-2 hover:text-fg hover:underline"
          onClick={onConfigure}
        >
          Change budget
        </button>
      </div>
    </div>
  );
}
