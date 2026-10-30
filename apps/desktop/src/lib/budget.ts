import type { BudgetLevel } from "./types";

/** Share of a cap at which the warning starts (matches the backend). */
export const WARN_AT = 0.8;

/** How far `spent` is into `cap`; no (or an unusable) cap is always "under". */
export function budgetLevel(spent: number, cap: number | null | undefined): BudgetLevel {
  if (cap == null || !Number.isFinite(cap) || cap <= 0) return "under";
  if (spent >= cap) return "hit";
  if (spent >= cap * WARN_AT) return "warn";
  return "under";
}

/** Whole percent of the cap spent (not clamped, so 130 means 30% over); null without a cap. */
export function budgetPercent(spent: number, cap: number | null | undefined): number | null {
  if (cap == null || !Number.isFinite(cap) || cap <= 0) return null;
  return Math.round((Math.max(0, spent) / cap) * 100);
}

/** Bar fill in 0-100. */
export function budgetFill(spent: number, cap: number | null | undefined): number {
  return Math.min(100, Math.max(0, budgetPercent(spent, cap) ?? 0));
}

/** Parses a currency field: empty = no cap (null); otherwise a number above $0. */
export function parseCap(text: string): { value: number | null; error?: string } {
  const t = text.trim().replace(/^\$/, "").replace(/,/g, "").trim();
  if (t === "") return { value: null };
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return { value: null, error: "Enter an amount like 25 or 12.50" };
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return { value: null, error: "Must be more than $0 (or leave empty for no cap)" };
  if (n > 1_000_000) return { value: null, error: "That's more than $1,000,000" };
  return { value: Math.round(n * 100) / 100 };
}

/** The text a currency field shows for a stored cap. */
export function capText(cap: number | null | undefined): string {
  return cap == null ? "" : String(cap);
}

export const BUDGET_LEVEL_LABEL: Record<Exclude<BudgetLevel, "under">, string> = {
  warn: "Over 80% of budget",
  hit: "Budget reached",
};
