import { describe, expect, it } from "vitest";
import type { AccountUsage, BudgetStatus, RemoteAccount } from "./types";
import {
  billingOf,
  budgetLevel,
  budgetPercent,
  budgetRows,
  hasDailyBudget,
  meterTone,
  parseBudget,
  parseUsage,
  planLabel,
  resetsIn,
  sortAccounts,
  spendByAccount,
  usageMeters,
  usageState,
  windowName,
} from "./usage";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

const usage = (over: Partial<AccountUsage> = {}): AccountUsage => ({ primary: null, secondary: null, fable: null, plan: null, updatedAt: NOW, ...over });
const account = (over: Partial<RemoteAccount> = {}): RemoteAccount => ({
  id: "a",
  name: "Work",
  provider: "claude",
  color: "#4FC3F7",
  label: null,
  authKind: "oauth",
  loggedIn: true,
  ...over,
});
const budget = (over: Partial<BudgetStatus> = {}): BudgetStatus => ({
  day: "2026-11-12",
  todayUsd: 0,
  dailyBudgetUsd: null,
  todayTokens: 0,
  dailyBudgetTokens: null,
  todayTurns: 0,
  dailyBudgetTurns: null,
  level: "under",
  ...over,
});

describe("usage windows", () => {
  it("names a window the way the desktop does", () => {
    expect(windowName({ windowMins: 300 })).toBe("5-hour");
    expect(windowName({ windowMins: 10080 })).toBe("Weekly");
    expect(windowName({ windowMins: 1440 })).toBe("Daily");
    expect(windowName({ windowMins: 180 })).toBe("3h window");
    expect(windowName({ windowMins: 45 })).toBe("45m window");
    expect(windowName({ windowMins: null })).toBe("Usage");
    expect(windowName({ windowMins: 0 })).toBe("Usage");
  });

  it("turns amber at 70% and red at 90%", () => {
    expect([0, 69, 70, 89, 90, 100].map(meterTone)).toEqual(["ok", "ok", "warn", "warn", "err", "err"]);
  });

  it("lists the windows an account reports, in order, with whole percents kept inside 0 to 100", () => {
    const meters = usageMeters(
      usage({
        primary: { usedPercent: 41.6, windowMins: 300, resetsAt: NOW + HOUR },
        secondary: { usedPercent: 140, windowMins: 10080, resetsAt: null },
        fable: { usedPercent: -3, windowMins: 10080, resetsAt: NOW + 2 * HOUR },
      }),
    );
    expect(meters.map((m) => [m.key, m.name, m.usedPercent, m.tone])).toEqual([
      ["primary", "5-hour", 42, "ok"],
      ["secondary", "Weekly", 100, "err"],
      ["fable", "Fable weekly", 0, "ok"],
    ]);
    expect(meters.map((m) => m.resetsAt)).toEqual([NOW + HOUR, null, NOW + 2 * HOUR]);
  });

  it("has no meters without usage, or with windows that hold no number", () => {
    expect(usageMeters(null)).toEqual([]);
    expect(usageMeters(undefined)).toEqual([]);
    expect(usageMeters(usage())).toEqual([]);
    expect(usageMeters(usage({ primary: {} as never, secondary: "x" as never }))).toEqual([]);
  });

  it("says when a window resets", () => {
    expect(resetsIn(null, NOW)).toBeNull();
    expect(resetsIn(NOW + 30_000, NOW)).toBe("resets in 1m");
    expect(resetsIn(NOW + 45 * MIN, NOW)).toBe("resets in 45m");
    expect(resetsIn(NOW + 2 * HOUR, NOW)).toBe("resets in 2h");
    expect(resetsIn(NOW + 2 * HOUR + 14 * MIN, NOW)).toBe("resets in 2h 14m");
    expect(resetsIn(NOW + 24 * HOUR, NOW)).toBe("resets in 1d");
    expect(resetsIn(NOW + 3 * 24 * HOUR + 5 * HOUR, NOW)).toBe("resets in 3d 5h");
  });

  it("does not count down to a time that has passed", () => {
    expect(resetsIn(NOW, NOW)).toBe("has reset since this was reported");
    expect(resetsIn(NOW - HOUR, NOW)).toBe("has reset since this was reported");
  });
});

describe("an account's plan and state", () => {
  it("shows the plan the provider reports, or the sign-in's fuller name for it", () => {
    expect(planLabel(account({ usage: usage({ plan: "pro" }), label: "Logged in using ChatGPT" }))).toBe("Pro");
    expect(planLabel(account({ plan: "max", label: "Claude Max 20x" }))).toBe("Claude Max 20x");
    expect(planLabel(account({ plan: "team", usage: usage({ plan: "max" }) }))).toBe("Max");
    expect(planLabel(account({ plan: "max" }))).toBe("Max");
  });

  it("falls back to the sign-in's label, then to nothing", () => {
    expect(planLabel(account({ label: "API key" }))).toBe("API key");
    expect(planLabel(account({ label: "  " }))).toBeNull();
    expect(planLabel(account())).toBeNull();
  });

  it("knows how an account is paid for", () => {
    expect(billingOf(account())).toBe("subscription");
    expect(billingOf(account({ authKind: "api_key" }))).toBe("api");
    expect(billingOf(account({ provider: "local" }))).toBe("local");
    expect(billingOf(account({ provider: "custom" }))).toBe("custom");
    // An older computer does not say: a sign-in is the common case.
    expect(billingOf(account({ authKind: undefined }))).toBe("subscription");
  });

  it("tells signed out, reporting, not reported yet, and nothing to report apart", () => {
    const reporting = usage({ primary: { usedPercent: 10, windowMins: 300, resetsAt: null } });
    expect(usageState(account({ usage: reporting }))).toBe("meters");
    expect(usageState(account({ usage: null }))).toBe("none");
    expect(usageState(account({ usage: usage() }))).toBe("none");
    expect(usageState(account())).toBe("none");
    expect(usageState(account({ authKind: "api_key" }))).toBe("unmetered");
    expect(usageState(account({ provider: "local" }))).toBe("unmetered");
    // Signed out wins: its last numbers would mislead.
    expect(usageState(account({ loggedIn: false, usage: reporting }))).toBe("signed_out");
    // Not checked yet is not signed out.
    expect(usageState(account({ loggedIn: null, usage: reporting }))).toBe("meters");
    expect(usageState(account({ loggedIn: undefined }))).toBe("none");
  });

  it("orders accounts by provider, then name", () => {
    const list = [
      account({ id: "1", provider: "custom", name: "Gemini" }),
      account({ id: "2", provider: "codex", name: "ChatGPT" }),
      account({ id: "3", provider: "claude", name: "Work" }),
      account({ id: "4", provider: "local", name: "GPU box" }),
      account({ id: "5", provider: "claude", name: "Personal" }),
      account({ id: "6", provider: "grok", name: "xAI" }),
    ];
    expect(sortAccounts(list).map((a) => a.name)).toEqual(["Personal", "Work", "ChatGPT", "xAI", "GPU box", "Gemini"]);
    expect(list[0].name).toBe("Gemini");
  });
});

describe("what an account's agents used", () => {
  it("adds up cost and tokens per account and skips agents without one", () => {
    const spend = spendByAccount([
      { accountId: "a", costUsd: 1.5, tokensUsed: 1000 },
      { accountId: "a", costUsd: 0.25, tokensUsed: 500 },
      { accountId: "b", costUsd: 0, tokensUsed: 0 },
      { accountId: "", costUsd: 9, tokensUsed: 9 },
      { accountId: "a", costUsd: Number.NaN, tokensUsed: -5 },
    ]);
    expect(spend.get("a")).toEqual({ costUsd: 1.75, tokens: 1500, agents: 3 });
    expect(spend.get("b")).toEqual({ costUsd: 0, tokens: 0, agents: 1 });
    expect(spend.has("")).toBe(false);
    expect(spend.get("nobody")).toBeUndefined();
  });
});

describe("today against the daily limits", () => {
  it("warns at 80% of a limit and stops at 100%", () => {
    expect(budgetLevel(7.99, 10)).toBe("under");
    expect(budgetLevel(8, 10)).toBe("warn");
    expect(budgetLevel(10, 10)).toBe("hit");
    expect(budgetLevel(50, null)).toBe("under");
    expect(budgetLevel(50, 0)).toBe("under");
  });

  it("gives the share spent, past 100 when over, and nothing without a limit", () => {
    expect(budgetPercent(5, 20)).toBe(25);
    expect(budgetPercent(26, 20)).toBe(130);
    expect(budgetPercent(5, null)).toBeNull();
    expect(budgetPercent(5, 0)).toBeNull();
  });

  it("shows cost and tokens always, turns only with a turn limit", () => {
    const rows = budgetRows(budget({ todayUsd: 16.4, dailyBudgetUsd: 20, todayTokens: 1_200_000, todayTurns: 31 }));
    expect(rows.map((r) => [r.key, r.spent, r.cap, r.percent, r.level])).toEqual([
      ["cost", 16.4, 20, 82, "warn"],
      ["tokens", 1_200_000, null, null, "under"],
    ]);
    const withTurns = budgetRows(budget({ todayTurns: 40, dailyBudgetTurns: 40 }));
    expect(withTurns.map((r) => r.key)).toEqual(["cost", "tokens", "turns"]);
    expect(withTurns[2]).toMatchObject({ spent: 40, cap: 40, percent: 100, level: "hit" });
    expect(budgetRows(null)).toEqual([]);
  });

  it("knows whether any limit is set", () => {
    expect(hasDailyBudget(null)).toBe(false);
    expect(hasDailyBudget(budget())).toBe(false);
    expect(hasDailyBudget(budget({ dailyBudgetUsd: 0 }))).toBe(false);
    expect(hasDailyBudget(budget({ dailyBudgetTokens: 5_000_000 }))).toBe(true);
    expect(hasDailyBudget(budget({ dailyBudgetTurns: 10 }))).toBe(true);
  });
});

describe("what the computer sends", () => {
  it("reads today's totals, and is nothing for an older computer or a share link", () => {
    const sent = { day: "2026-11-12", todayUsd: 3.2, dailyBudgetUsd: 20, todayTokens: 9000, dailyBudgetTokens: null, todayTurns: 4, dailyBudgetTurns: null, level: "warn" };
    expect(parseBudget(sent)).toEqual(sent);
    for (const raw of [undefined, null, "x", 3, {}, { todayUsd: "3" }]) expect(parseBudget(raw)).toBeNull();
    expect(parseBudget({ todayUsd: 1, todayTokens: 2, level: "odd", dailyBudgetUsd: "20" })).toEqual(
      budget({ day: "", todayUsd: 1, todayTokens: 2 }),
    );
  });

  it("reads an account's usage and drops windows it cannot use", () => {
    expect(parseUsage(null)).toBeNull();
    expect(parseUsage("x")).toBeNull();
    expect(
      parseUsage({
        primary: { usedPercent: 12, windowMins: 300, resetsAt: NOW },
        secondary: { usedPercent: "lots" },
        fable: { usedPercent: 3 },
        plan: "max",
        updatedAt: NOW,
        accessToken: "must not be carried along",
      }),
    ).toEqual({
      primary: { usedPercent: 12, windowMins: 300, resetsAt: NOW },
      secondary: null,
      fable: { usedPercent: 3, windowMins: null, resetsAt: null },
      plan: "max",
      updatedAt: NOW,
    });
  });
});
