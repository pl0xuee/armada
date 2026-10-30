import { Wallet } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/misc";
import { BUDGET_LEVEL_LABEL, budgetLevel, budgetPercent } from "@/lib/budget";
import { formatCost } from "@/lib/format";
import type { Agent } from "@/lib/types";
import { useApp } from "@/store/app";

/** Shown when an agent has spent 80% or more of the per-agent budget. */
export function BudgetChip({ agent, compact }: { agent: Agent; compact?: boolean }) {
  const cap = useApp((s) => s.settings?.agentBudgetUsd);
  const level = budgetLevel(agent.costUsd, cap);
  if (level === "under" || cap == null) return null;
  const pct = budgetPercent(agent.costUsd, cap) ?? 0;
  return (
    <Tooltip content={`${BUDGET_LEVEL_LABEL[level]}: ${formatCost(agent.costUsd)} of ${formatCost(cap)}`}>
      <span className="inline-flex" role="img" aria-label={`${BUDGET_LEVEL_LABEL[level]}, ${pct}%`}>
        <Badge tone={level === "hit" ? "err" : "warn"} className="px-1">
          <Wallet />
          {!compact && <span className="tabular">{pct}%</span>}
        </Badge>
      </span>
    </Tooltip>
  );
}
