import { budgetLevel, budgetPercent } from "./budget";
import { formatCost, formatTokens } from "./format";
import type {
  Account,
  Agent,
  BudgetCap,
  BudgetHold,
  BudgetLevel,
  BudgetMetric,
  BudgetScope,
  BudgetStatus,
  Settings,
} from "./types";

/** Parses a token-limit field: "50000", "50k", "1.5M" (commas ok). Empty = no limit (null). */
export function parseTokenCap(text: string): { value: number | null; error?: string } {
  const t = text.trim().replace(/,/g, "").replace(/\s+/g, "").toLowerCase();
  if (t === "") return { value: null };
  const m = /^(\d*\.?\d+)([km]?)$/.exec(t);
  if (!m) return { value: null, error: "Enter a number of tokens like 500000, 500k or 1.5M" };
  const n = Math.round(Number(m[1]) * (m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1_000 : 1));
  if (!Number.isFinite(n) || n <= 0) return { value: null, error: "Must be more than 0 (or leave empty for no limit)" };
  if (n > 1e12) return { value: null, error: "That's more than a trillion tokens" };
  return { value: n };
}

/** What a token-limit field shows for a stored limit. */
export function tokenCapText(cap: number | null | undefined): string {
  if (cap == null) return "";
  if (cap % 1_000_000 === 0) return `${cap / 1_000_000}M`;
  if (cap % 1_000 === 0) return `${cap / 1_000}k`;
  return String(cap);
}

/** True when the agent's cost is an API-equivalent figure (a subscription), not a bill per token. */
export function costIsEquivalent(agent: Agent, accounts: readonly Account[]): boolean {
  const account = accounts.find((a) => a.id === agent.accountId);
  return agent.provider !== "local" && account?.authKind !== "api_key";
}

/**
 * Whether this agent reports a cost at all. Local models never do; a custom agent may or may not,
 * and until it has shown one there is nothing to measure a cost limit against.
 */
export function reportsCost(agent: Agent): boolean {
  if (agent.provider === "local") return false;
  if (agent.provider === "custom") return agent.costUsd > 0;
  return true;
}

export interface BudgetMeter {
  scope: BudgetScope;
  metric: BudgetMetric;
  spent: number;
  cap: number;
  pct: number;
  level: BudgetLevel;
  /** A cost limit on an agent that reports no cost: nothing is being measured. */
  blind: boolean;
}

export const SCOPE_NAME: Record<BudgetScope, string> = {
  daily: "Today",
  project: "Project",
  agent: "This agent",
};

/** "$1.20 of $5.00" or "12k of 50k tokens". */
export function meterAmounts(metric: BudgetMetric, spent: number, cap: number): string {
  return metric === "cost"
    ? `${formatCost(spent)} of ${formatCost(cap)}`
    : `${formatTokens(spent)} of ${formatTokens(cap)} tokens`;
}

/** The limits that apply to an agent and where it stands against each (only those that are set). */
export function budgetMeters(
  agent: Agent,
  project: { usd: number; tokens: number },
  settings: Pick<
    Settings,
    "dailyBudgetUsd" | "dailyBudgetTokens" | "agentBudgetUsd" | "agentBudgetTokens" | "projectBudgets"
  >,
  daily: BudgetStatus | null,
): BudgetMeter[] {
  const own: BudgetCap = agent.budget ?? { usd: null, tokens: null };
  const rows: [BudgetScope, BudgetMetric, number, number | null | undefined][] = [
    ["agent", "cost", agent.costUsd, own.usd ?? settings.agentBudgetUsd],
    ["agent", "tokens", agent.tokensUsed, own.tokens ?? settings.agentBudgetTokens],
    ["project", "cost", project.usd, settings.projectBudgets[agent.projectPath]?.usd],
    ["project", "tokens", project.tokens, settings.projectBudgets[agent.projectPath]?.tokens],
    ["daily", "cost", daily?.todayUsd ?? 0, settings.dailyBudgetUsd],
    ["daily", "tokens", daily?.todayTokens ?? 0, settings.dailyBudgetTokens],
  ];
  const blind = !reportsCost(agent);
  const out: BudgetMeter[] = [];
  for (const [scope, metric, spent, cap] of rows) {
    if (cap == null || !(cap > 0)) continue;
    out.push({
      scope,
      metric,
      spent,
      cap,
      pct: budgetPercent(spent, cap) ?? 0,
      level: budgetLevel(spent, cap),
      blind: blind && metric === "cost" && scope !== "daily",
    });
  }
  return out;
}

const LEVEL_RANK: Record<BudgetLevel, number> = { under: 0, warn: 1, hit: 2 };

/** The meter closest to its limit (ignoring ones that measure nothing), if any. */
export function worstMeter(meters: readonly BudgetMeter[]): BudgetMeter | null {
  let best: BudgetMeter | null = null;
  for (const m of meters) {
    if (m.blind) continue;
    if (!best || LEVEL_RANK[m.level] > LEVEL_RANK[best.level] || (m.level === best.level && m.pct > best.pct)) best = m;
  }
  return best;
}

/** What the tooltip says about one meter. */
export function meterLine(m: BudgetMeter, equivalent: boolean): string {
  const name = SCOPE_NAME[m.scope];
  if (m.blind) return `${name}: this agent doesn't report a cost, so a cost limit can't measure it. Use a token limit.`;
  const note = m.metric === "cost" && equivalent ? " (API-equivalent, not a bill)" : "";
  return `${name}: ${meterAmounts(m.metric, m.spent, m.cap)}${note}`;
}

/** The dollar/token increments a "Raise limit" button can offer for a hold. */
export function raiseSteps(hold: BudgetHold): number[] {
  if (hold.metric === "cost") {
    const base = hold.cap < 10 ? 5 : hold.cap < 50 ? 10 : hold.cap < 200 ? 25 : 100;
    return [base, base * 2];
  }
  const nice = [10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000];
  const want = hold.cap * 0.5;
  const step = nice.find((n) => n >= want) ?? Math.ceil(want / 1_000_000) * 1_000_000;
  return [step, step * 2];
}

/** "$5" / "50k tokens". */
export function raiseLabel(hold: BudgetHold, by: number): string {
  return hold.metric === "cost" ? formatCost(by).replace(/\.00$/, "") : `${formatTokens(by)} tokens`;
}

const SCOPE_PHRASE: Record<BudgetScope, string> = {
  daily: "the daily limit",
  project: "this project's limit",
  agent: "its own limit",
};

/** The sentence a "Needs you" item leads with. */
export function holdText(hold: BudgetHold, equivalent: boolean): string {
  const amounts = meterAmounts(hold.metric, hold.spent, hold.cap);
  const note = hold.metric === "cost" && equivalent ? " (API-equivalent cost, not a bill)" : "";
  return `Reached ${SCOPE_PHRASE[hold.scope]}: ${amounts}${note}.`;
}
