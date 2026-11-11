import { describe, expect, it } from "vitest";
import { accountSpend, billingOf, budgetLeft, windowsLeft } from "./billing";

describe("billingOf", () => {
  it("tells API keys, subscriptions and local models apart", () => {
    expect(billingOf({ authKind: "api_key" }, "claude").mode).toBe("api");
    expect(billingOf({ authKind: "oauth" }, "claude").mode).toBe("subscription");
    expect(billingOf({ authKind: "default" }, "codex").mode).toBe("subscription");
    expect(billingOf(null, "grok").mode).toBe("subscription");
    expect(billingOf({ authKind: "api_key" }, "local").mode).toBe("local");
  });
});

describe("windowsLeft", () => {
  it("reports what is left of each window", () => {
    const w = windowsLeft({
      primary: { usedPercent: 12.4, windowMins: 300, resetsAt: 5 },
      secondary: { usedPercent: 99.6, windowMins: 10080, resetsAt: null },
      plan: null,
      updatedAt: 0,
    });
    expect(w).toEqual([
      { name: "5-hour", usedPercent: 12, leftPercent: 88, resetsAt: 5 },
      { name: "Weekly", usedPercent: 100, leftPercent: 0, resetsAt: null },
    ]);
    expect(windowsLeft(null)).toEqual([]);
  });
});

describe("budgetLeft", () => {
  it("counts what is left of the daily limit", () => {
    expect(budgetLeft({ todayUsd: 7.5, dailyBudgetUsd: 20 })).toEqual({
      spentUsd: 7.5,
      budgetUsd: 20,
      leftUsd: 12.5,
      usedPercent: 38,
    });
  });
  it("never goes below zero, and says nothing is left to count without a limit", () => {
    expect(budgetLeft({ todayUsd: 30, dailyBudgetUsd: 20 })).toMatchObject({ leftUsd: 0, usedPercent: 100 });
    expect(budgetLeft({ todayUsd: 3, dailyBudgetUsd: null })).toMatchObject({ budgetUsd: null, leftUsd: null });
    expect(budgetLeft(null)).toBeNull();
  });
});

describe("accountSpend", () => {
  it("adds up only the agents on that account", () => {
    const agents = [
      { accountId: "a", costUsd: 1.5, archived: false },
      { accountId: "a", costUsd: 2, archived: true },
      { accountId: "b", costUsd: 700, archived: false },
    ];
    expect(accountSpend(agents, "a")).toBe(3.5);
    expect(accountSpend(agents, "none")).toBe(0);
  });
});

describe("windowsLeft with Fable", () => {
  it("lists Claude's Fable weekly allowance after the shared windows", () => {
    const w = windowsLeft({
      primary: null,
      secondary: { usedPercent: 25, windowMins: 10080, resetsAt: 9 },
      fable: { usedPercent: 40, windowMins: 10080, resetsAt: 9 },
      plan: null,
      updatedAt: 0,
    });
    expect(w.map((x) => [x.name, x.leftPercent])).toEqual([
      ["Weekly", 75],
      ["Fable weekly", 60],
    ]);
  });
});
