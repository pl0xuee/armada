import { Wallet } from "lucide-react";
import { useMemo } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/misc";
import { BUDGET_LEVEL_LABEL } from "@/lib/budget";
import { budgetMeters, costIsEquivalent, meterLine, meterShort, worstMeter } from "@/lib/budgetMeters";
import { useBudgetStatus } from "@/hooks/useBudgetStatus";
import type { Agent, BudgetStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";

/** What the agents of one project have spent together. */
function useProjectSpend(projectPath: string): { usd: number; tokens: number; turns: number } {
  const usd = useApp((s) => {
    let sum = 0;
    for (const a of Object.values(s.agents)) if (a.projectPath === projectPath) sum += a.costUsd;
    return sum;
  });
  const tokens = useApp((s) => {
    let sum = 0;
    for (const a of Object.values(s.agents)) if (a.projectPath === projectPath) sum += a.tokensUsed;
    return sum;
  });
  const turns = useApp((s) => {
    let sum = 0;
    for (const a of Object.values(s.agents)) if (a.projectPath === projectPath) sum += a.turns ?? 0;
    return sum;
  });
  return useMemo(() => ({ usd, tokens, turns }), [usd, tokens, turns]);
}

const BAR = { under: "bg-accent", warn: "bg-warn", hit: "bg-err" } as const;

/**
 * Where an agent stands against the spending limits that apply to it. In lists it only appears
 * from 80% on; in an agent's header (`always`) it is there whenever any limit is set, and says
 * nothing otherwise.
 */
export function BudgetChip({ agent, compact, always }: { agent: Agent; compact?: boolean; always?: boolean }) {
  return always ? <HeaderMeter agent={agent} compact={compact} /> : <ListChip agent={agent} compact={compact} />;
}

function useMeters(agent: Agent, daily: BudgetStatus | null) {
  const settings = useApp((s) => s.settings);
  const accounts = useApp((s) => s.accounts);
  const project = useProjectSpend(agent.projectPath);
  return useMemo(() => {
    if (!settings) return { meters: [], equivalent: false };
    return {
      meters: budgetMeters(agent, project, settings, daily),
      equivalent: costIsEquivalent(agent, accounts),
    };
  }, [agent, project, settings, daily, accounts]);
}

function ListChip({ agent, compact }: { agent: Agent; compact?: boolean }) {
  const { meters, equivalent } = useMeters(agent, null);
  const worst = worstMeter(meters);
  if (!worst || worst.level === "under") return null;
  return (
    <Tooltip content={`${BUDGET_LEVEL_LABEL[worst.level]}. ${meterLine(worst, equivalent)}`}>
      <span className="inline-flex" role="img" aria-label={`${BUDGET_LEVEL_LABEL[worst.level]}, ${worst.pct}%`}>
        <Badge tone={worst.level === "hit" ? "err" : "warn"} className="px-1">
          <Wallet />
          {!compact && <span className="tabular">{worst.pct}%</span>}
        </Badge>
      </span>
    </Tooltip>
  );
}

function HeaderMeter({ agent, compact }: { agent: Agent; compact?: boolean }) {
  // Today's spend is read from the backend again as the fleet's cost moves.
  const fleetCost = useApp((s) => {
    let sum = 0;
    for (const a of Object.values(s.agents)) sum += a.costUsd;
    return sum;
  });
  const daily = useBudgetStatus(fleetCost);
  const { meters, equivalent } = useMeters(agent, daily);
  if (meters.length === 0) return null;
  const worst = worstMeter(meters);
  const held = !!agent.budgetHold;
  const tip = (
    <span className="flex max-w-[280px] flex-col gap-1 py-0.5 text-left">
      {held && <span className="font-medium text-warn">Paused at a limit. Choose how to go on in Needs you.</span>}
      {meters.map((m) => (
        <span key={`${m.scope}-${m.metric}`}>{meterLine(m, equivalent)}</span>
      ))}
      <span className="text-steel">
        {meters.some((m) => m.metric === "cost" && !m.blind) && equivalent
          ? "Cost is what the runtime reports; a subscription isn't billed per token."
          : "Limits are checked when a turn ends."}
      </span>
    </span>
  );
  // Only cost limits on an agent that reports no cost: nothing is being measured.
  if (!worst) {
    return (
      <Tooltip content={tip}>
        <span role="img" aria-label="Cost limit set, but this agent reports no cost" className="inline-flex">
          <Badge className="px-1 opacity-70">
            <Wallet />
            {!compact && <span>No cost</span>}
          </Badge>
        </span>
      </Tooltip>
    );
  }
  const label = held ? "Paused at a limit" : worst.level === "under" ? "Budget" : BUDGET_LEVEL_LABEL[worst.level];
  return (
    <Tooltip content={tip}>
      <span role="img" aria-label={`${label}, ${worst.pct}%`} className="inline-flex">
        <Badge
          tone={worst.level === "hit" ? "err" : worst.level === "warn" ? "warn" : "neutral"}
          className={cn("gap-1.5", compact ? "px-1" : "px-1.5")}
        >
          <Wallet />
          {!compact && (
            <>
              <span aria-hidden className="h-1 w-8 overflow-hidden rounded-full bg-raised">
                <span
                  className={cn("block h-full rounded-full transition-[width] duration-300", BAR[worst.level])}
                  style={{ width: `${Math.min(100, worst.pct)}%` }}
                />
              </span>
              <span className="tabular">{meterShort(worst)}</span>
            </>
          )}
        </Badge>
      </span>
    </Tooltip>
  );
}
