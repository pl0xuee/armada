import { describe, expect, it } from "vitest";
import { holdAmounts, holdLabel, holdReach, holdText, holdTitle, raiseLabel, raiseSteps, type HoldLike } from "./budgetHold";
import { needsReason, reasonLabel, triageQueue, triageSections } from "./triage";
import type { Agent } from "./types";

const hold = (metric: string, spent: number, cap: number, scope = "agent"): HoldLike => ({ scope, metric, spent, cap });

describe("how a hold reads", () => {
  it("says dollars and tokens the way the desktop does", () => {
    const cost = hold("cost", 3.08, 3);
    expect(holdTitle(cost)).toBe("Paused at a spending limit");
    expect(holdLabel(cost)).toBe("Spending limit");
    expect(holdAmounts(cost)).toBe("$3.08 of $3.00");
    expect(holdText(cost)).toBe("Reached its own limit: $3.08 of $3.00.");
    const tokens = hold("tokens", 52_000, 50_000, "daily");
    expect(holdAmounts(tokens)).toBe("52k of 50k tokens");
    expect(holdText(tokens)).toBe("Reached the daily limit: 52k of 50k tokens.");
    expect(holdText(hold("cost", 5, 5, "project"))).toBe("Reached this project's limit: $5.00 of $5.00.");
  });

  it("names a limit kind it has no wording for instead of breaking", () => {
    const turns = hold("turns", 41, 40);
    expect(holdTitle(turns)).toBe("Paused at a turn limit");
    expect(holdLabel(turns)).toBe("Turn limit");
    expect(holdAmounts(turns)).toBe("41 of 40 turns");
    expect(holdText(turns)).toBe("Reached its own limit: 41 of 40 turns.");
    const odd = hold("api_calls", 1_200, 1_000);
    expect(holdLabel(odd)).toBe("Api call limit");
    expect(holdAmounts(odd)).toBe("1,200 of 1,000 api calls");
    // Nothing known at all still produces words.
    const blank = { scope: "galaxy", metric: "", spent: 2, cap: 1 };
    expect(holdLabel(blank)).toBe("Usage limit");
    expect(holdText(blank)).toBe("Reached a limit: 2 of 1.");
    expect(holdAmounts(hold("turns", 1, 1))).toBe("1 of 1 turn");
  });

  it("says whose limit changes when it is more than this agent", () => {
    expect(holdReach(hold("cost", 1, 1, "project"), "/code/web")).toContain("every agent in web");
    expect(holdReach(hold("cost", 1, 1, "project"), undefined)).toContain("every agent in this project");
    expect(holdReach(hold("cost", 1, 1, "daily"), "/code/web")).toContain("today's limit");
    expect(holdReach(hold("cost", 1, 1, "agent"), "/code/web")).toBeNull();
    expect(holdReach(hold("turns", 1, 1, "weekly"), "/code/web")).toBeNull();
  });
});

describe("raise steps", () => {
  it("match the desktop for dollars and tokens", () => {
    expect(raiseSteps(hold("cost", 3.1, 3))).toEqual([5, 10]);
    expect(raiseSteps(hold("cost", 21, 20))).toEqual([10, 20]);
    expect(raiseSteps(hold("cost", 130, 100))).toEqual([25, 50]);
    expect(raiseSteps(hold("cost", 600, 500))).toEqual([100, 200]);
    expect(raiseSteps(hold("tokens", 52_000, 50_000))).toEqual([25_000, 50_000]);
    expect(raiseSteps(hold("tokens", 2e9, 1.5e9))).toEqual([750e6, 1.5e9]);
  });

  it("match the desktop for turns", () => {
    expect(raiseSteps(hold("turns", 11, 10))).toEqual([5, 10]);
    expect(raiseSteps(hold("turns", 41, 40))).toEqual([10, 20]);
    expect(raiseSteps(hold("turns", 101, 100))).toEqual([25, 50]);
    expect(raiseSteps(hold("turns", 500, 450))).toEqual([50, 100]);
  });

  it("scale with the cap for a count of anything else, always above zero", () => {
    expect(raiseSteps(hold("api_calls", 41, 40))).toEqual([20, 40]);
    expect(raiseSteps(hold("api_calls", 1, 1))).toEqual([1, 2]);
    for (const cap of [0, 0.2, 3, 7, 99, 12_345]) {
      const [a, b] = raiseSteps(hold("whatever", cap, cap));
      expect(a).toBeGreaterThan(0);
      expect(Number.isInteger(a)).toBe(true);
      expect(b).toBe(a * 2);
    }
  });

  it("label the button", () => {
    expect(raiseLabel(hold("cost", 1, 1), 5)).toBe("$5");
    expect(raiseLabel(hold("cost", 1, 1), 2.5)).toBe("$2.50");
    expect(raiseLabel(hold("tokens", 1, 1), 50_000)).toBe("50k tokens");
    expect(raiseLabel(hold("turns", 1, 1), 20)).toBe("20 turns");
    expect(raiseLabel(hold("turns", 1, 1), 1)).toBe("1 turn");
  });
});

let n = 0;
const agent = (extra: Partial<Agent> = {}): Agent =>
  ({
    id: `h${++n}`,
    title: `Agent ${n}`,
    status: "idle",
    archived: false,
    unread: false,
    rateLimited: false,
    pendingPermissions: 0,
    acknowledgedAt: null,
    lastActivityAt: 1000,
    projectPath: "/code/web",
    branch: null,
    lastMessage: null,
    ...extra,
  }) as Agent;

describe("a held agent in Needs you", () => {
  const held = { scope: "agent", metric: "cost", spent: 3.08, cap: 3, since: 900 } as Agent["budgetHold"];

  it("is waiting on you, not 'Done'", () => {
    expect(needsReason(agent({ budgetHold: held, unread: true }))).toBe("budget");
    expect(needsReason(agent({ budgetHold: held }))).toBe("budget");
    expect(needsReason(agent({ budgetHold: null, unread: true }))).toBe("done");
  });

  it("stays after 'Done', like an approval, and gives way to one", () => {
    expect(needsReason(agent({ budgetHold: held, acknowledgedAt: 5000 }))).toBe("budget");
    expect(needsReason(agent({ budgetHold: held, pendingPermissions: 1 }))).toBe("permission");
    expect(needsReason(agent({ budgetHold: held, archived: true }))).toBeNull();
  });

  it("outranks a usage limit, an error and finished work, and is Blocked", () => {
    const list = [
      agent({ id: "done", unread: true }),
      agent({ id: "err", status: "error" }),
      agent({ id: "limit", rateLimited: true, status: "error" }),
      agent({ id: "hold", budgetHold: held }),
      agent({ id: "perm", pendingPermissions: 1 }),
    ];
    const queue = triageQueue(list);
    expect(queue.map((e) => e.agent.id)).toEqual(["perm", "hold", "limit", "err", "done"]);
    const sections = triageSections(queue);
    expect(sections[0].id).toBe("blocked");
    expect(sections[0].entries.map((e) => e.agent.id)).toContain("hold");
    expect(reasonLabel("budget")).toBe("Limit reached");
  });
});
