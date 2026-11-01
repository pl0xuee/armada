import { describe, expect, it } from "vitest";
import {
  budgetMeters,
  holdText,
  meterLine,
  meterShort,
  parseTurnCap,
  raiseLabel,
  raiseSteps,
  turnCapText,
  worstMeter,
} from "./budgetMeters";
import type { Agent, BudgetHold, BudgetStatus } from "./types";

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
    turns: 0,
    budget: null,
    budgetHold: null,
    ...over,
  }) as Agent;

const settings = {
  dailyBudgetUsd: null,
  dailyBudgetTokens: null,
  dailyBudgetTurns: null,
  agentBudgetUsd: null,
  agentBudgetTokens: null,
  agentBudgetTurns: null,
  projectBudgets: {},
};

const none = { usd: 0, tokens: 0, turns: 0 };

describe("parseTurnCap / turnCapText", () => {
  it("reads whole numbers; empty means no limit", () => {
    expect(parseTurnCap("")).toEqual({ value: null });
    expect(parseTurnCap(" 20 ")).toEqual({ value: 20 });
    expect(parseTurnCap("1,200")).toEqual({ value: 1200 });
  });
  it("rejects zero, fractions, suffixes and junk", () => {
    for (const bad of ["0", "-5", "2.5", "20 turns", "5k", "abc", "99999999"]) {
      expect(parseTurnCap(bad).error, bad).toBeTruthy();
    }
  });
  it("shows a stored limit", () => {
    expect(turnCapText(null)).toBe("");
    expect(turnCapText(undefined)).toBe("");
    expect(turnCapText(20)).toBe("20");
  });
});

describe("turn meters", () => {
  it("measures the agent, its project and the day against their turn limits", () => {
    const daily = { todayUsd: 0, todayTokens: 0, todayTurns: 9, dailyBudgetTurns: 10 } as BudgetStatus;
    const meters = budgetMeters(
      agent({ turns: 7 }),
      { usd: 0, tokens: 0, turns: 12 },
      {
        ...settings,
        agentBudgetTurns: 20,
        dailyBudgetTurns: 10,
        projectBudgets: { "/work/app": { usd: null, tokens: null, turns: 12 } },
      },
      daily,
    );
    expect(meters.map((m) => `${m.scope}:${m.metric}:${m.pct}:${m.level}`)).toEqual([
      "agent:turns:35:under",
      "project:turns:100:hit",
      "daily:turns:90:warn",
    ]);
    expect(worstMeter(meters)).toMatchObject({ scope: "project", metric: "turns" });
    // A turn limit never reads as "blind": every agent has turns.
    expect(meters.every((m) => !m.blind)).toBe(true);
  });

  it("an agent's own raised limit wins over the default, and old data without turns counts as zero", () => {
    const own = budgetMeters(
      agent({ turns: 21, budget: { usd: null, tokens: null, turns: 30 } }),
      none,
      { ...settings, agentBudgetTurns: 20 },
      null,
    );
    expect(own[0]).toMatchObject({ cap: 30, spent: 21, level: "under" });
    const old = budgetMeters(agent({ turns: undefined }), none, { ...settings, agentBudgetTurns: 20 }, null);
    expect(old[0]).toMatchObject({ spent: 0, pct: 0 });
    // Settings from before turn limits have no such fields at all.
    const bare = { ...settings } as Record<string, unknown>;
    delete bare.agentBudgetTurns;
    delete bare.dailyBudgetTurns;
    expect(budgetMeters(agent({ turns: 3 }), none, bare as typeof settings, null)).toEqual([]);
  });

  it("says '7 / 20 turns' in the header and the plain percent for other units", () => {
    const [m] = budgetMeters(agent({ turns: 7 }), none, { ...settings, agentBudgetTurns: 20 }, null);
    expect(meterShort(m!)).toBe("7 / 20 turns");
    expect(meterLine(m!, true)).toBe("This agent: 7 of 20 turns");
    const [c] = budgetMeters(agent({ costUsd: 1 }), none, { ...settings, agentBudgetUsd: 4 }, null);
    expect(meterShort(c!)).toBe("25%");
  });
});

describe("a turn hold", () => {
  const hold: BudgetHold = { scope: "agent", metric: "turns", spent: 20, cap: 20, since: 0 };
  it("is worded in turns and never calls itself a bill", () => {
    expect(holdText(hold, true)).toBe("Reached its own limit: 20 of 20 turns.");
    expect(holdText({ ...hold, scope: "daily", spent: 51, cap: 50 }, false)).toBe(
      "Reached the daily limit: 51 of 50 turns.",
    );
  });
  it("offers whole-turn raises that scale with the limit", () => {
    expect(raiseSteps(hold)).toEqual([10, 20]);
    expect(raiseSteps({ ...hold, cap: 5 })).toEqual([5, 10]);
    expect(raiseSteps({ ...hold, cap: 80 })).toEqual([25, 50]);
    expect(raiseSteps({ ...hold, cap: 400 })).toEqual([50, 100]);
    expect(raiseLabel(hold, 10)).toBe("10 turns");
  });
});
