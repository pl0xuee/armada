import { describe, expect, it } from "vitest";
import {
  DOCK_ORDER,
  PLAN_COLLAPSE_AT,
  blockers,
  dockSections,
  latestNeedsYou,
  lingerStarts,
  needsYouKind,
  planIsLive,
  planPhase,
  planProgress,
  planStartsOpen,
  quickKeyIndex,
  resetClause,
  withoutReset,
} from "./pinned";
import type { PlanEntry, TimelineItem } from "./types";

const step = (status: PlanEntry["status"], content: string = status): PlanEntry => ({
  content,
  status,
  priority: null,
});

describe("planProgress", () => {
  it("counts done steps and finds the current one", () => {
    const p = planProgress([
      step("completed", "a"),
      step("completed", "b"),
      step("in_progress", "c"),
      step("pending", "d"),
    ]);
    expect(p).toMatchObject({ total: 4, done: 2, currentIndex: 2, complete: false });
    expect(p.current?.content).toBe("c");
  });
  it("falls back to the first pending step when nothing is in progress", () => {
    const p = planProgress([step("completed", "a"), step("pending", "b"), step("pending", "c")]);
    expect(p.current?.content).toBe("b");
    expect(p.currentIndex).toBe(1);
  });
  it("takes the first in-progress step when several are", () => {
    const p = planProgress([step("pending", "a"), step("in_progress", "b"), step("in_progress", "c")]);
    expect(p.current?.content).toBe("b");
  });
  it("is complete only when every step is, and an empty plan is not", () => {
    expect(planProgress([step("completed"), step("completed")])).toMatchObject({ complete: true, current: null });
    expect(planProgress([]).complete).toBe(false);
  });
});

describe("planPhase and the finish linger", () => {
  const running = planProgress([step("completed"), step("in_progress")]);
  const finished = planProgress([step("completed"), step("completed")]);
  const idle = { live: true, busy: true, lingering: false };

  it("pins an unfinished plan of the current turn while the agent works", () => {
    expect(planPhase(running, idle)).toBe("active");
  });
  it("does not pin a plan from an earlier turn, or one an idle agent left behind", () => {
    expect(planPhase(running, { ...idle, live: false })).toBeNull();
    expect(planPhase(running, { ...idle, busy: false })).toBeNull();
  });
  it("shows a finished plan only while it lingers", () => {
    expect(planPhase(finished, idle)).toBeNull();
    expect(planPhase(finished, { ...idle, lingering: true })).toBe("done");
  });
  it("shows nothing without a plan or with an empty one", () => {
    expect(planPhase(null, idle)).toBeNull();
    expect(planPhase(planProgress([]), idle)).toBeNull();
  });
  it("starts the linger only when a pinned plan stopped being active because it finished", () => {
    expect(lingerStarts(true, null, finished)).toBe(true);
    // Never seen active (an old finished plan on load): no linger.
    expect(lingerStarts(false, null, finished)).toBe(false);
    // The turn ended with steps left: it just folds away.
    expect(lingerStarts(true, null, running)).toBe(false);
    // Still active.
    expect(lingerStarts(true, "active", running)).toBe(false);
  });
});

describe("planStartsOpen", () => {
  it("collapses a long plan by default and opens a short one", () => {
    expect(planStartsOpen(PLAN_COLLAPSE_AT - 1, undefined)).toBe(true);
    expect(planStartsOpen(PLAN_COLLAPSE_AT, undefined)).toBe(false);
  });
  it("remembers what the user chose", () => {
    expect(planStartsOpen(8, true)).toBe(true);
    expect(planStartsOpen(2, false)).toBe(false);
  });
});

let seq = 0;
const item = (x: Record<string, unknown>) =>
  ({ id: `i${seq}`, agentId: "a", seq: seq++, ts: seq, ...x }) as unknown as TimelineItem;

describe("planIsLive", () => {
  it("is live when the plan comes after the last user message", () => {
    expect(planIsLive([item({ kind: "user_message", text: "x" }), item({ kind: "plan", entries: [] })])).toBe(true);
  });
  it("is not live once a newer user message started another turn", () => {
    expect(planIsLive([item({ kind: "plan", entries: [] }), item({ kind: "user_message", text: "again" })])).toBe(
      false,
    );
  });
  it("ignores a message typed into the running turn", () => {
    expect(
      planIsLive([
        item({ kind: "user_message", text: "go" }),
        item({ kind: "plan", entries: [] }),
        item({ kind: "user_message", text: "also this", midTurn: true }),
      ]),
    ).toBe(true);
  });
  it("is false without a plan", () => {
    expect(planIsLive([item({ kind: "user_message", text: "x" })])).toBe(false);
  });
});

describe("dockSections order", () => {
  it("lists what is relevant, most important first", () => {
    expect(
      dockSections({ queue: true, subagents: true, plan: true, conflict: true, rate_limit: true, needs_you: true }),
    ).toEqual(["needs_you", "rate_limit", "conflict", "plan", "subagents", "queue"]);
  });
  it("puts blockers before the plan and the plan before sub-agents and the queue", () => {
    expect(DOCK_ORDER.indexOf("error")).toBeLessThan(DOCK_ORDER.indexOf("plan"));
    expect(DOCK_ORDER.indexOf("budget")).toBeLessThan(DOCK_ORDER.indexOf("plan"));
    expect(DOCK_ORDER.indexOf("plan")).toBeLessThan(DOCK_ORDER.indexOf("subagents"));
    expect(DOCK_ORDER.indexOf("subagents")).toBeLessThan(DOCK_ORDER.indexOf("queue"));
  });
  it("is empty when nothing is relevant", () => {
    expect(dockSections({})).toEqual([]);
    expect(dockSections({ plan: false, queue: false })).toEqual([]);
  });
});

describe("blockers", () => {
  const base = { status: "working", rateLimited: false, costUsd: 0.5, helperSync: null, parentId: null } as const;
  const settings = { agentBudgetUsd: 3, budgetAction: "pause" };
  it("has none for a healthy agent", () => {
    expect(blockers(base, settings)).toEqual({ rateLimit: false, error: false, budget: false, conflict: false });
  });
  it("flags a usage limit, but not for a stopped agent (the Resume banner is shown)", () => {
    expect(blockers({ ...base, status: "error", rateLimited: true }, settings)).toMatchObject({
      rateLimit: true,
      error: false,
    });
    expect(blockers({ ...base, status: "interrupted", rateLimited: true }, settings).rateLimit).toBe(false);
  });
  it("flags an error that is not a usage limit", () => {
    expect(blockers({ ...base, status: "error" }, settings).error).toBe(true);
  });
  it("flags a reached budget only when the setting pauses agents and the agent is not running", () => {
    const hit = { ...base, status: "idle", costUsd: 3.2 } as const;
    expect(blockers(hit, settings).budget).toBe(true);
    expect(blockers(hit, { ...settings, budgetAction: "notify" }).budget).toBe(false);
    expect(blockers({ ...hit, status: "working" }, settings).budget).toBe(false);
    expect(blockers({ ...hit, costUsd: 2.5 }, settings).budget).toBe(false);
    expect(blockers(hit, { ...settings, agentBudgetUsd: null }).budget).toBe(false);
  });
  it("flags a helper's merge conflict, and only for a helper", () => {
    const sync = { state: "conflict" } as never;
    expect(blockers({ ...base, parentId: "main", helperSync: sync }, settings).conflict).toBe(true);
    expect(blockers({ ...base, helperSync: sync }, settings).conflict).toBe(false);
  });
});

describe("needs you", () => {
  const perm = (resolution: string | null, plan?: string) =>
    item({ kind: "permission", requestId: `p${seq}`, title: "Run x", options: [], diffs: [], resolution, plan });
  const question = (resolution: string | null) =>
    item({ kind: "question", requestId: `q${seq}`, message: "Which?", fields: [], resolution });

  it("picks the newest unanswered approval, then a question", () => {
    const old = perm(null);
    const newer = perm(null);
    expect(latestNeedsYou([old, newer, question(null)])).toBe(newer);
    const q = question(null);
    expect(latestNeedsYou([perm("allow"), q])).toBe(q);
    expect(latestNeedsYou([perm("allow"), question("answered")])).toBeNull();
    expect(latestNeedsYou(undefined)).toBeNull();
  });
  it("names the kind", () => {
    expect(needsYouKind(perm(null))).toBe("approval");
    expect(needsYouKind(perm(null, "# Plan"))).toBe("plan_approval");
    expect(needsYouKind(question(null))).toBe("question");
    expect(needsYouKind(null)).toBeNull();
  });
});

describe("quickKeyIndex", () => {
  const key = (k: string, mods: Partial<Record<"shiftKey" | "ctrlKey" | "metaKey" | "altKey", boolean>> = {}) => ({
    key: k,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...mods,
  });
  it("maps 1..9 to rows 0..8 within the row count", () => {
    expect(quickKeyIndex(key("1"), 4)).toBe(0);
    expect(quickKeyIndex(key("4"), 4)).toBe(3);
    expect(quickKeyIndex(key("5"), 4)).toBeNull();
    expect(quickKeyIndex(key("9"), 9)).toBe(8);
  });
  it("ignores other keys and modified ones", () => {
    expect(quickKeyIndex(key("0"), 4)).toBeNull();
    expect(quickKeyIndex(key("a"), 4)).toBeNull();
    expect(quickKeyIndex(key("1", { metaKey: true }), 4)).toBeNull();
    expect(quickKeyIndex(key("1", { ctrlKey: true }), 4)).toBeNull();
    expect(quickKeyIndex(key("1", { shiftKey: true }), 4)).toBeNull();
  });
});

describe("usage limit reset time", () => {
  it("finds the reset clause in the provider's wording", () => {
    expect(resetClause("Claude usage limit reached for Personal (Max 5x). Resets at 6:00 PM.")).toBe(
      "Resets at 6:00 PM",
    );
    expect(resetClause("Limit reached, resets in 2 hours")).toBe("Resets in 2 hours");
    expect(resetClause("Weekly limit reached. Resets Tue 10:23 PM")).toBe("Resets Tue 10:23 PM");
  });
  it("is null when no reset time is named", () => {
    expect(resetClause("Rate limit reached for this account.")).toBeNull();
    expect(resetClause(null)).toBeNull();
    expect(resetClause("")).toBeNull();
  });
  it("removes the clause from the message", () => {
    expect(withoutReset("Claude usage limit reached for Personal. Resets at 6:00 PM.")).toBe(
      "Claude usage limit reached for Personal.",
    );
    expect(withoutReset("Nothing to cut here.")).toBe("Nothing to cut here.");
  });
});
