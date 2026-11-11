// How an account is paid for, and how much of it is left. Pure helpers (the card is in
// components/usage/BillingSummary.tsx).
//
// What is known: a subscription reports how much of each usage window is spent (and when it resets);
// an API-key account is billed per token, and Kvistcode adds up what its agents cost today. What is
// NOT known: the prepaid credit balance, which neither Anthropic nor OpenAI lets a plain API key read.
// So for API billing "left" means left of the daily budget the user set, and the UI says so.
//
// The daily figure (BudgetStatus.todayUsd) adds up EVERY agent's cost on every cloud account, subscription
// agents included, priced at API rates. It is what the daily budget limits, not what any one key was billed,
// so it must never be shown as "spent on your API key".
import type { Account, AccountUsage, Agent, BudgetStatus, Provider, UsageWindow } from "./types";

export type BillingMode = "subscription" | "api" | "local";

export interface Billing {
  mode: BillingMode;
  /** "Subscription", "API billing" or "Local model". */
  label: string;
  /** One short line on what that means for cost. */
  detail: string;
}

export function billingOf(account: Pick<Account, "authKind"> | null | undefined, provider: Provider): Billing {
  if (provider === "local")
    return { mode: "local", label: "Local model", detail: "Runs on your machine. No per-token cost." };
  if (account?.authKind === "api_key")
    return { mode: "api", label: "API billing", detail: "Billed per token on your API key." };
  return { mode: "subscription", label: "Subscription", detail: "Covered by your plan. Cost shown is an estimate." };
}

export interface WindowLeft {
  /** 5-hour, Weekly, … */
  name: string;
  usedPercent: number;
  leftPercent: number;
  resetsAt: number | null;
}

const windowName = (w: UsageWindow): string => {
  const m = w.windowMins;
  if (m === null) return "Usage";
  if (m === 300) return "5-hour";
  if (m === 10080) return "Weekly";
  if (m === 1440) return "Daily";
  return m % 60 === 0 ? `${m / 60}h window` : `${m}m window`;
};

/** What is left of each usage window a subscription reports (none when the provider reports none). */
export function windowsLeft(usage: AccountUsage | null | undefined): WindowLeft[] {
  const out: WindowLeft[] = [];
  const named: [UsageWindow | null | undefined, string | null][] = [
    [usage?.primary, null],
    [usage?.secondary, null],
    [usage?.fable, "Fable weekly"],
  ];
  for (const [w, name] of named) {
    if (!w) continue;
    const used = Math.max(0, Math.min(100, Math.round(w.usedPercent)));
    out.push({ name: name ?? windowName(w), usedPercent: used, leftPercent: 100 - used, resetsAt: w.resetsAt });
  }
  return out;
}

export interface BudgetLeft {
  spentUsd: number;
  /** The daily limit, or null when none is set. */
  budgetUsd: number | null;
  /** Left of the limit today (never below 0), or null with no limit. */
  leftUsd: number | null;
  /** Share of the limit spent, 0 to 100 (0 with no limit). */
  usedPercent: number;
}

/** Today's spend against the daily cost limit. */
export function budgetLeft(
  status: Pick<BudgetStatus, "todayUsd" | "dailyBudgetUsd"> | null | undefined,
): BudgetLeft | null {
  if (!status) return null;
  const budget = status.dailyBudgetUsd != null && status.dailyBudgetUsd > 0 ? status.dailyBudgetUsd : null;
  const spent = Math.max(0, status.todayUsd);
  return {
    spentUsd: spent,
    budgetUsd: budget,
    leftUsd: budget === null ? null : Math.max(0, budget - spent),
    usedPercent: budget === null ? 0 : Math.min(100, Math.round((spent / budget) * 100)),
  };
}

/** What the agents on one account have used so far (their own cost, not the fleet's). */
export function accountSpend(agents: Pick<Agent, "accountId" | "costUsd" | "archived">[], accountId: string): number {
  let usd = 0;
  for (const a of agents) if (a.accountId === accountId) usd += Math.max(0, a.costUsd || 0);
  return usd;
}
