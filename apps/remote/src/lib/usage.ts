/**
 * Usage per account, as the desktop's Usage and Accounts screens show it: the windows a provider reports
 * for a subscription (5-hour, weekly, …) and today against the daily limits. Pure helpers; the screen is
 * `screens/Usage.tsx`. The numbers are the desktop's own (the phone never asks a provider anything).
 */
import { PROVIDERS } from "./meta";
import type { AccountUsage, Agent, BudgetLevel, BudgetStatus, RemoteAccount, UsageWindow } from "./types";

/** Same thresholds as the desktop's meters. */
export type MeterTone = "ok" | "warn" | "err";
export const meterTone = (usedPercent: number): MeterTone => (usedPercent >= 90 ? "err" : usedPercent >= 70 ? "warn" : "ok");

export function windowName(w: Pick<UsageWindow, "windowMins">): string {
  const m = w.windowMins;
  if (m === null || m === undefined || !Number.isFinite(m) || m <= 0) return "Usage";
  if (m === 300) return "5-hour";
  if (m === 10080) return "Weekly";
  if (m === 1440) return "Daily";
  return m % 60 === 0 ? `${m / 60}h window` : `${m}m window`;
}

export interface Meter {
  key: "primary" | "secondary" | "fable";
  /** "5-hour", "Weekly", "Fable weekly". */
  name: string;
  /** Whole percent used, 0 to 100. */
  usedPercent: number;
  resetsAt: number | null;
  tone: MeterTone;
}

const isWindow = (w: unknown): w is UsageWindow => !!w && typeof w === "object" && typeof (w as UsageWindow).usedPercent === "number";

/** The windows an account reports, in the desktop's order. None when the provider reported none. */
export function usageMeters(usage: AccountUsage | null | undefined): Meter[] {
  if (!usage) return [];
  const out: Meter[] = [];
  const named: [Meter["key"], unknown, string | null][] = [
    ["primary", usage.primary, null],
    ["secondary", usage.secondary, null],
    ["fable", usage.fable, "Fable weekly"],
  ];
  for (const [key, w, name] of named) {
    if (!isWindow(w)) continue;
    const used = Math.max(0, Math.min(100, Math.round(w.usedPercent)));
    out.push({ key, name: name ?? windowName(w), usedPercent: used, resetsAt: typeof w.resetsAt === "number" ? w.resetsAt : null, tone: meterTone(used) });
  }
  return out;
}

/**
 * "resets in 2h 14m". A reset time that has passed means the window started over after the provider's
 * last report, so the number shown is the old one: said plainly instead of a time in the past.
 */
export function resetsIn(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null;
  const ms = resetsAt - now;
  if (ms <= 0) return "has reset since this was reported";
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `resets in ${hours}h${mins % 60 ? ` ${mins % 60}m` : ""}`;
  const days = Math.floor(hours / 24);
  return `resets in ${days}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The plan an account is on: what the provider reports with its usage, else what the sign-in check found
 * ("Pro", as on the desktop). The sign-in's own label wins when it names that plan more fully
 * ("Claude Max 20x" for "max"), and stands in when no plan is known ("API key").
 */
export function planLabel(account: Pick<RemoteAccount, "label" | "plan" | "usage">): string | null {
  const label = account.label?.trim() || null;
  const plan = (account.usage?.plan ?? account.plan)?.trim();
  if (!plan) return label;
  return label && label.toLowerCase().includes(plan.toLowerCase()) ? label : capitalize(plan);
}

/** How an account is paid for (the desktop's `billingOf`). */
export type Billing = "subscription" | "api" | "local" | "custom";
export function billingOf(account: Pick<RemoteAccount, "provider" | "authKind">): Billing {
  if (account.provider === "local") return "local";
  if (account.provider === "custom") return "custom";
  return account.authKind === "api_key" ? "api" : "subscription";
}

/**
 * What to say about an account's limits:
 *  - "signed_out": the sign-in check says it is signed out (its last numbers would mislead);
 *  - "meters": the provider reported at least one window;
 *  - "unmetered": nothing to report by design (an API key is billed per token; a local model has no limit);
 *  - "none": a subscription that hasn't reported yet.
 */
export type UsageState = "signed_out" | "meters" | "unmetered" | "none";
export function usageState(account: Pick<RemoteAccount, "provider" | "authKind" | "loggedIn" | "usage">): UsageState {
  if (account.loggedIn === false) return "signed_out";
  if (usageMeters(account.usage).length) return "meters";
  return billingOf(account) === "subscription" ? "none" : "unmetered";
}

export interface Spend {
  costUsd: number;
  tokens: number;
  agents: number;
}

/** What each account's agents used since they were created (archived ones too, as on the desktop's Usage screen). */
export function spendByAccount(agents: readonly Pick<Agent, "accountId" | "costUsd" | "tokensUsed">[]): Map<string, Spend> {
  const out = new Map<string, Spend>();
  for (const a of agents) {
    if (!a.accountId) continue;
    const s = out.get(a.accountId) ?? { costUsd: 0, tokens: 0, agents: 0 };
    s.costUsd += Math.max(0, a.costUsd || 0);
    s.tokens += Math.max(0, a.tokensUsed || 0);
    s.agents += 1;
    out.set(a.accountId, s);
  }
  return out;
}

const PROVIDER_ORDER = ["claude", "codex", "grok", "local", "custom"];

/** Accounts by provider (Claude, Codex, Grok, local, custom), then by name. */
export function sortAccounts<A extends Pick<RemoteAccount, "provider" | "name">>(accounts: readonly A[]): A[] {
  const rank = (a: A) => {
    const i = PROVIDER_ORDER.indexOf(a.provider);
    return i < 0 ? PROVIDER_ORDER.length : i;
  };
  return [...accounts].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** "Claude", "Codex", … for an account's provider. */
export const providerName = (account: Pick<RemoteAccount, "provider">) => (PROVIDERS[account.provider] ?? PROVIDERS.custom).short;

// ---------------------------------------------------------------------------
// Today against the daily limits

/** Share of a limit at which the warning starts (matches the desktop and the core). */
const WARN_AT = 0.8;

const usable = (cap: number | null | undefined): cap is number => cap != null && Number.isFinite(cap) && cap > 0;

export function budgetLevel(spent: number, cap: number | null | undefined): BudgetLevel {
  if (!usable(cap)) return "under";
  if (spent >= cap) return "hit";
  return spent >= cap * WARN_AT ? "warn" : "under";
}

/** Whole percent of the limit spent (not clamped: 130 is 30% over); null without a limit. */
export function budgetPercent(spent: number, cap: number | null | undefined): number | null {
  return usable(cap) ? Math.round((Math.max(0, spent) / cap) * 100) : null;
}

export interface BudgetRow {
  key: "cost" | "tokens" | "turns";
  label: string;
  spent: number;
  /** null: no limit set for this measure. */
  cap: number | null;
  percent: number | null;
  level: BudgetLevel;
}

/**
 * Today's cost and tokens always, turns only with a turn limit (the desktop's "Today's budget" rows), each
 * with its limit when one is set.
 */
export function budgetRows(b: BudgetStatus | null | undefined): BudgetRow[] {
  if (!b) return [];
  const row = (key: BudgetRow["key"], label: string, spent: number, cap: number | null | undefined): BudgetRow => {
    const s = Math.max(0, Number.isFinite(spent) ? spent : 0);
    return { key, label, spent: s, cap: usable(cap) ? cap : null, percent: budgetPercent(s, cap), level: budgetLevel(s, cap) };
  };
  const rows = [row("cost", "Cost", b.todayUsd, b.dailyBudgetUsd), row("tokens", "Tokens", b.todayTokens, b.dailyBudgetTokens)];
  if (usable(b.dailyBudgetTurns)) rows.push(row("turns", "Turns", b.todayTurns, b.dailyBudgetTurns));
  return rows;
}

/** Whether any daily limit is set. */
export const hasDailyBudget = (b: BudgetStatus | null | undefined): boolean =>
  !!b && (usable(b.dailyBudgetUsd) || usable(b.dailyBudgetTokens) || usable(b.dailyBudgetTurns));

/** A budget the server sent, or null when it sent none or something unreadable. */
export function parseBudget(raw: unknown): BudgetStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const x = raw as Record<string, unknown>;
  if (typeof x.todayUsd !== "number" || typeof x.todayTokens !== "number") return null;
  const cap = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    day: typeof x.day === "string" ? x.day : "",
    todayUsd: x.todayUsd,
    dailyBudgetUsd: cap(x.dailyBudgetUsd),
    todayTokens: x.todayTokens,
    dailyBudgetTokens: cap(x.dailyBudgetTokens),
    todayTurns: typeof x.todayTurns === "number" ? x.todayTurns : 0,
    dailyBudgetTurns: cap(x.dailyBudgetTurns),
    level: x.level === "warn" || x.level === "hit" ? x.level : "under",
  };
}

/** The usage a server sent for an account: only windows with a number survive; null when there is nothing. */
export function parseUsage(raw: unknown): AccountUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const x = raw as Record<string, unknown>;
  const win = (w: unknown): UsageWindow | null =>
    isWindow(w)
      ? {
          usedPercent: w.usedPercent,
          windowMins: typeof w.windowMins === "number" ? w.windowMins : null,
          resetsAt: typeof w.resetsAt === "number" ? w.resetsAt : null,
        }
      : null;
  return {
    primary: win(x.primary),
    secondary: win(x.secondary),
    fable: win(x.fable),
    plan: typeof x.plan === "string" ? x.plan : null,
    updatedAt: typeof x.updatedAt === "number" ? x.updatedAt : 0,
  };
}
