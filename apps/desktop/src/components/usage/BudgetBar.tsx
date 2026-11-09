import { Wallet } from "lucide-react";
import { budgetFill, budgetLevel, budgetPercent } from "@/lib/budget";
import { formatCost, formatTokens } from "@/lib/format";
import type { BudgetStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const FILL = { under: "bg-accent", warn: "bg-warn", hit: "bg-err" } as const;
const TEXT = { under: "text-muted", warn: "text-warn", hit: "text-err" } as const;

function Row({
  label,
  spent,
  cap,
  format,
}: {
  label: string;
  spent: number;
  cap: number;
  format: (n: number) => string;
}) {
  const pct = budgetPercent(spent, cap) ?? 0;
  const level = budgetLevel(spent, cap);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-x-4 text-small tabular">
        <span className="text-steel">{label}</span>
        <span className="flex items-baseline gap-2">
          <span className="font-medium text-fg">{format(spent)}</span>
          <span className="text-steel">of {format(cap)}</span>
          <span className={cn("w-9 text-right font-medium", TEXT[level])}>{pct}%</span>
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${label} against the daily limit`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, pct)}
        className="mt-1.5 h-1.5 overflow-hidden rounded-[4px] bg-raised/70"
      >
        <div
          className={cn("h-full rounded-[4px] transition-[width] duration-300", FILL[level])}
          style={{ width: `${budgetFill(spent, cap)}%` }}
        />
      </div>
    </div>
  );
}

/** Today's spend against the daily limits (cost and/or tokens): compact progress bars. */
export function BudgetBar({ status, onConfigure }: { status: BudgetStatus; onConfigure: () => void }) {
  const cost = status.dailyBudgetUsd;
  const tokens = status.dailyBudgetTokens;
  const turns = status.dailyBudgetTurns;
  if (cost == null && tokens == null && turns == null) return null;
  return (
    <div className="space-y-2.5 rounded-xl border border-line bg-card px-4 py-3 edge">
      <div className="flex items-center gap-1.5 eyebrow text-steel [&_svg]:h-3.5 [&_svg]:w-3.5">
        <Wallet />
        Today&rsquo;s budget
      </div>
      {cost != null && <Row label="Cost" spent={status.todayUsd} cap={cost} format={formatCost} />}
      {tokens != null && <Row label="Tokens" spent={status.todayTokens} cap={tokens} format={formatTokens} />}
      {turns != null && (
        <Row label="Turns" spent={status.todayTurns} cap={turns} format={(n) => String(Math.round(n))} />
      )}
      <div className="text-meta text-steel">
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
