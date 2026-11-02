/**
 * An agent held at a limit (`Agent.budgetHold`): what to say about it and which "Raise limit" steps to
 * offer. The phone's copy of the desktop's `budgetMeters.ts` hold helpers, written from the hold's
 * fields rather than a fixed list of limit kinds: the core can add one (a turn limit, say), and an
 * unknown kind still reads sensibly instead of breaking the card.
 */
import { basename, formatCost, formatTokens } from "./format";

/** The fields of a hold the phone reads (the wire shape of `BudgetHold`, with kinds left open). */
export interface HoldLike {
  scope: string;
  metric: string;
  spent: number;
  cap: number;
}

/** What the user can do about a hold: the body of `POST /api/agents/{id}/budget`. */
export type HoldChoice = { action: "raise"; by: number } | { action: "continue_once" } | { action: "stop" };

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** "turns" -> "turn", "api_calls" -> "api call": the noun for a limit kind we have no wording for. */
function noun(metric: string): string {
  const words = metric.replace(/[_-]+/g, " ").trim().toLowerCase();
  return (words.endsWith("s") && words.length > 3 ? words.slice(0, -1) : words) || "usage";
}

/** The card's title. */
export function holdTitle(hold: HoldLike): string {
  if (hold.metric === "cost" || hold.metric === "tokens") return "Paused at a spending limit";
  return `Paused at a ${noun(hold.metric)} limit`;
}

/** The short name in lists and labels: "Spending limit", "Turn limit". */
export function holdLabel(hold: HoldLike): string {
  if (hold.metric === "cost" || hold.metric === "tokens") return "Spending limit";
  const n = noun(hold.metric);
  return `${n.charAt(0).toUpperCase()}${n.slice(1)} limit`;
}

/** "$1.20 of $5.00", "12k of 50k tokens", "12 of 10 turns". */
export function holdAmounts(hold: HoldLike): string {
  if (hold.metric === "cost") return `${formatCost(hold.spent)} of ${formatCost(hold.cap)}`;
  if (hold.metric === "tokens") return `${formatTokens(hold.spent)} of ${formatTokens(hold.cap)} tokens`;
  if (!hold.metric.trim()) return `${num(hold.spent)} of ${num(hold.cap)}`;
  const n = noun(hold.metric);
  return `${num(hold.spent)} of ${num(hold.cap)} ${n}${hold.cap === 1 ? "" : "s"}`;
}

const SCOPE_PHRASE: Record<string, string> = {
  daily: "the daily limit",
  project: "this project's limit",
  agent: "its own limit",
};

/** The sentence a held agent leads with. */
export function holdText(hold: HoldLike, equivalent = false): string {
  const note = hold.metric === "cost" && equivalent ? " (API-equivalent cost, not a bill)" : "";
  return `Reached ${SCOPE_PHRASE[hold.scope] ?? "a limit"}: ${holdAmounts(hold)}${note}.`;
}

/** A hint for a cost limit on a subscription: it is not billed per token, so another kind of limit may fit better. */
export const SUBSCRIPTION_HOLD_HINT = "Subscriptions aren't billed per token, so a turn or token limit may fit this account better.";

/** Whose limit changes when it is raised, when that is more than this agent. */
export function holdReach(hold: HoldLike, projectPath: string | undefined): string | null {
  if (hold.scope === "project") return projectPath ? `Raising it changes the limit for every agent in ${basename(projectPath)}.` : "Raising it changes the limit for every agent in this project.";
  if (hold.scope === "daily") return "Raising it changes today's limit for all agents.";
  return null;
}

/** Two increments for "Raise limit by": the desktop's for dollars and tokens, a share of the cap otherwise. */
export function raiseSteps(hold: HoldLike): [number, number] {
  if (hold.metric === "cost") {
    const base = hold.cap < 10 ? 5 : hold.cap < 50 ? 10 : hold.cap < 200 ? 25 : 100;
    return [base, base * 2];
  }
  if (hold.metric === "tokens") {
    const nice = [10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000];
    const want = hold.cap * 0.5;
    const step = nice.find((n) => n >= want) ?? Math.ceil(want / 1_000_000) * 1_000_000;
    return [step, step * 2];
  }
  // Counts of anything else: about half the cap again, rounded to a number that reads well.
  const want = Math.max(1, hold.cap * 0.5);
  const mag = 10 ** Math.floor(Math.log10(want));
  const step = Math.max(1, Math.ceil(want / mag) * mag);
  return [step, step * 2];
}

/** "$5", "50k tokens", "10 turns". */
export function raiseLabel(hold: HoldLike, by: number): string {
  if (hold.metric === "cost") return formatCost(by).replace(/\.00$/, "");
  if (hold.metric === "tokens") return `${formatTokens(by)} tokens`;
  if (!hold.metric.trim()) return num(by);
  return `${num(by)} ${noun(hold.metric)}${by === 1 ? "" : "s"}`;
}
