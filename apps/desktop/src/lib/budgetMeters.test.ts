import { describe, expect, it } from "vitest";
import { needsAttention, triageQueue } from "./agents";
import {
  budgetMeters,
  costIsEquivalent,
  holdText,
  meterLine,
  parseTokenCap,
  raiseLabel,
  raiseSteps,
  reportsCost,
  tokenCapText,
  worstMeter,
} from "./budgetMeters";
import type { Account, Agent, BudgetHold, BudgetStatus } from "./types";

const agent = (over: Partial<Agent> = {}): Agent =>
  ({
    id: "a1",
    title: "Fix tests",
    provider: "claude",
    accountId: "acc",
    projectPath: "/work/app",
    status: "idle",
    costUsd: 0,
    tokensUsed: 0,
    pendingPermissions: 0,
    archived: false,
    unread: false,
    acknowledgedAt: null,
    lastActivityAt: 1000,
    rateLimited: false,
    budget: null,
    budgetHold: null,
    ...over,
  }) as Agent;

const settings = {
  dailyBudgetUsd: null,
  dailyBudgetTokens: null,
  agentBudgetUsd: null,
  agentBudgetTokens: null,
  projectBudgets: {},
};

const none = { usd: 0, tokens: 0 };

describe("parseTokenCap / tokenCapText", () => {
  it("reads plain numbers and k / M suffixes", () => {
    expect(parseTokenCap("")).toEqual({ value: null });
    expect(parseTokenCap("50000")).toEqual({ value: 50_000 });
    expect(parseTokenCap("500k")).toEqual({ value: 500_000 });
    expect(parseTokenCap("1.5M")).toEqual({ value: 1_500_000 });
    expect(parseTokenCap("1,200,000")).toEqual({ value: 1_200_000 });
    expect(parseTokenCap(" 2 m ")).toEqual({ value: 2_000_000 });
  });
  it("rejects zero, negatives and junk", () => {
    for (const bad of ["0", "-5", "abc", "1e3", "k", "5 tokens", "99999999999999"]) {
      expect(parseTokenCap(bad).error, bad).toBeTruthy();
    }
  });
  it("shows a stored limit the short way", () => {
    expect(tokenCapText(null)).toBe("");
    expect(tokenCapText(500_000)).toBe("500k");
    expect(tokenCapText(2_000_000)).toBe("2M");
    expect(tokenCapText(1_234)).toBe("1234");
  });
});

describe("budgetMeters", () => {
  it("has nothing to show without limits", () => {
    expect(budgetMeters(agent({ costUsd: 5 }), none, settings, null)).toEqual([]);
  });

  it("measures an agent, its project and the day, in cost and tokens", () => {
    const daily = { todayUsd: 6, todayTokens: 0, dailyBudgetUsd: 10, dailyBudgetTokens: null } as BudgetStatus;
    const meters = budgetMeters(
      agent({ costUsd: 2, tokensUsed: 90_000 }),
      { usd: 9, tokens: 400_000 },
      {
        ...settings,
        dailyBudgetUsd: 10,
        agentBudgetUsd: 4,
        agentBudgetTokens: 100_000,
        projectBudgets: { "/work/app": { usd: 10, tokens: null } },
      },
      daily,
    );
    expect(meters.map((m) => `${m.scope}:${m.metric}:${m.pct}:${m.level}`)).toEqual([
      "agent:cost:50:under",
      "agent:tokens:90:warn",
      "project:cost:90:warn",
      "daily:cost:60:under",
    ]);
    // The meter closest to its limit is the one the header shows.
    expect(worstMeter(meters)).toMatchObject({ scope: "agent", metric: "tokens" });
  });

  it("a limit raised for one agent wins over the default", () => {
    const m = budgetMeters(
      agent({ costUsd: 5, budget: { usd: 20, tokens: null } }),
      none,
      { ...settings, agentBudgetUsd: 4 },
      null,
    );
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ cap: 20, pct: 25, level: "under" });
  });

  it("is honest about a cost limit on an agent that reports no cost", () => {
    const local = agent({ provider: "local", tokensUsed: 5000 });
    const m = budgetMeters(local, none, { ...settings, agentBudgetUsd: 5, agentBudgetTokens: 10_000 }, null);
    expect(m.find((x) => x.metric === "cost")?.blind).toBe(true);
    expect(m.find((x) => x.metric === "tokens")?.blind).toBe(false);
    expect(meterLine(m[0]!, false)).toMatch(/doesn't report a cost/);
    // Only the token meter counts toward what the header shows.
    expect(worstMeter(m)?.metric).toBe("tokens");
    expect(worstMeter(m.filter((x) => x.blind))).toBeNull();
  });

  it("calls a subscription's cost API-equivalent, never a bill", () => {
    const m = budgetMeters(agent({ costUsd: 2 }), none, { ...settings, agentBudgetUsd: 4 }, null)[0]!;
    expect(meterLine(m, true)).toBe("This agent: $2.00 of $4.00 (API-equivalent, not a bill)");
    expect(meterLine(m, false)).toBe("This agent: $2.00 of $4.00");
    const tokens = budgetMeters(agent({ tokensUsed: 5000 }), none, { ...settings, agentBudgetTokens: 10_000 }, null)[0]!;
    expect(meterLine(tokens, true)).toBe("This agent: 5.0k of 10k tokens");
  });
});

describe("who reports a cost", () => {
  const accounts = [
    { id: "key", authKind: "api_key" },
    { id: "sub", authKind: "oauth" },
  ] as Account[];
  it("tells billed API keys from subscriptions and local models", () => {
    expect(costIsEquivalent(agent({ accountId: "key" }), accounts)).toBe(false);
    expect(costIsEquivalent(agent({ accountId: "sub" }), accounts)).toBe(true);
    expect(costIsEquivalent(agent({ provider: "local", accountId: "key" }), accounts)).toBe(false);
    expect(reportsCost(agent({ provider: "local" }))).toBe(false);
    expect(reportsCost(agent({ provider: "custom", costUsd: 0 }))).toBe(false);
    expect(reportsCost(agent({ provider: "custom", costUsd: 0.2 }))).toBe(true);
    expect(reportsCost(agent())).toBe(true);
  });
});

describe("hold wording and raise steps", () => {
  const cost: BudgetHold = { scope: "agent", metric: "cost", spent: 3.08, cap: 3, since: 0 };
  const tokens: BudgetHold = { scope: "project", metric: "tokens", spent: 1_100_000, cap: 1_000_000, since: 0 };
  it("offers sensible increments", () => {
    expect(raiseSteps(cost)).toEqual([5, 10]);
    expect(raiseSteps({ ...cost, cap: 30 })).toEqual([10, 20]);
    expect(raiseSteps({ ...cost, cap: 300 })).toEqual([100, 200]);
    expect(raiseSteps(tokens)).toEqual([500_000, 1_000_000]);
    expect(raiseSteps({ ...tokens, cap: 40_000 })).toEqual([25_000, 50_000]);
    expect(raiseLabel(cost, 5)).toBe("$5");
    expect(raiseLabel(tokens, 500_000)).toBe("500k tokens");
  });
  it("says what was reached", () => {
    expect(holdText(cost, false)).toBe("Reached its own limit: $3.08 of $3.00.");
    expect(holdText(cost, true)).toContain("API-equivalent cost, not a bill");
    expect(holdText(tokens, true)).toBe("Reached this project's limit: 1.10M of 1.00M tokens.");
  });
});

describe("a held agent is a Needs-you item", () => {
  const hold: BudgetHold = { scope: "daily", metric: "cost", spent: 11, cap: 10, since: 5 };
  it("sits below approvals and above everything else, and dismissal does not hide it", () => {
    const held = agent({ id: "held", budgetHold: hold, unread: true, acknowledgedAt: 5000, lastActivityAt: 1000 });
    expect(needsAttention(held)).toBe("budget");
    const limited = agent({ id: "lim", rateLimited: true });
    const asking = agent({ id: "ask", status: "needs_permission", pendingPermissions: 1 });
    const failed = agent({ id: "err", status: "error" });
    const order = triageQueue([failed, limited, held, asking]).map((e) => e.agent.id);
    expect(order).toEqual(["ask", "held", "lim", "err"]);
  });
  it("is gone once the hold is cleared, and archived agents never need you", () => {
    expect(needsAttention(agent({ budgetHold: null }))).toBeNull();
    expect(needsAttention(agent({ budgetHold: hold, archived: true }))).toBeNull();
  });
});
