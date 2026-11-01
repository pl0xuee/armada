import { describe, expect, it } from "vitest";
import {
  dockBlock,
  dockNeed,
  latestPlan,
  lingerStarts,
  planIsLive,
  planPhase,
  planProgress,
  quickAnswers,
  quickQuestion,
  questionHeadline,
  resetClause,
  subagentHeadline,
  withoutReset,
} from "./dock";
import type { PendingItem, PlanEntry, QuestionField, TimelineItem } from "./types";

let n = 0;
const perm = (extra: object = {}) =>
  ({
    id: `p${++n}`,
    agentId: "a",
    seq: n,
    ts: n,
    kind: "permission",
    requestId: `r${n}`,
    title: "Run x",
    toolKind: "execute",
    command: "x",
    diffs: [],
    options: [],
    resolution: null,
    ...extra,
  }) as unknown as PendingItem;
const question = (fields: QuestionField[], extra: object = {}) =>
  ({
    id: `q${++n}`,
    agentId: "a",
    seq: n,
    ts: n,
    kind: "question",
    requestId: `r${n}`,
    message: "Which?",
    source: null,
    fields,
    resolution: null,
    ...extra,
  }) as unknown as PendingItem;
const opt = (v: string) => ({ value: v, label: v.toUpperCase(), description: null });

describe("dockNeed", () => {
  it("is null with nothing open", () => {
    expect(dockNeed(undefined)).toBeNull();
    expect(dockNeed([perm({ resolution: "allow" })])).toBeNull();
  });
  it("shows the newest approval first (it acts before a question) and counts the rest", () => {
    const old = perm({ ts: 1 });
    const fresh = perm({ ts: 9 });
    const q = question([{ id: "f", kind: "single", options: [opt("a")] }], { ts: 20 });
    const need = dockNeed([old, q, fresh])!;
    expect(need.item).toBe(fresh);
    expect(need.kind).toBe("permission");
    expect(need.more).toBe(2);
  });
  it("knows a plan approval and a question", () => {
    expect(dockNeed([perm({ plan: "# Plan\n1. do it" })])!.kind).toBe("plan");
    expect(dockNeed([question([])])!.kind).toBe("question");
  });
});

describe("quickQuestion", () => {
  const single = (opts: string[], extra: Partial<QuestionField> = {}): QuestionField => ({
    id: "f",
    kind: "single",
    options: opts.map(opt),
    ...extra,
  });
  it("answers a single choice with one tap, up to four options", () => {
    const q = quickQuestion({ fields: [single(["a", "b", "c", "d"])] })!;
    expect(q.mode).toBe("single");
    expect(quickAnswers(q, ["b"])).toEqual({ f: "b" });
    expect(quickQuestion({ fields: [single(["a", "b", "c", "d", "e"])] })).toBeNull();
  });
  it("answers multi-select (up to six) keeping the options' order", () => {
    const q = quickQuestion({ fields: [{ id: "m", kind: "multi", options: ["a", "b", "c"].map(opt) }] })!;
    expect(q.mode).toBe("multi");
    expect(quickAnswers(q, ["c", "a"])).toEqual({ m: ["a", "c"] });
    expect(quickQuestion({ fields: [{ id: "m", kind: "multi", options: "abcdefg".split("").map(opt) }] })).toBeNull();
  });
  it("answers yes/no", () => {
    const q = quickQuestion({ fields: [{ id: "b", kind: "boolean" }] })!;
    expect(q.mode).toBe("boolean");
    expect(quickAnswers(q, ["true"])).toEqual({ b: true });
    expect(quickAnswers(q, ["false"])).toEqual({ b: false });
  });
  it("sends several questions, typed values and secrets to the full form", () => {
    expect(quickQuestion({ fields: [single(["a"]), { id: "g", kind: "single", options: [opt("x")] }] })).toBeNull();
    expect(quickQuestion({ fields: [{ id: "t", kind: "text" }] })).toBeNull();
    expect(quickQuestion({ fields: [single(["a", "b"], { secret: true })] })).toBeNull();
  });
  it("notes an 'Other' box (the full form takes it) and still offers the choices", () => {
    const q = quickQuestion({ fields: [single(["a", "b"]), { id: "f_other", kind: "text", otherFor: "f" }] })!;
    expect(q.hasOther).toBe(true);
    expect(q.choices.map((c) => c.value)).toEqual(["a", "b"]);
  });
  it("headlines with the message, else the lone field's words", () => {
    expect(questionHeadline({ message: "Pick one", fields: [] })).toBe("Pick one");
    expect(questionHeadline({ message: "", fields: [single(["a"], { description: "Which runner?" })] })).toBe("Which runner?");
    expect(questionHeadline({ message: "", fields: [] })).toBe("Your agent has a question");
  });
});

describe("dockBlock", () => {
  const a = (extra: object = {}) => ({ status: "idle", rateLimited: false, helperSync: null, parentId: null, ...extra }) as never;
  it("is null for a healthy agent", () => {
    expect(dockBlock(a())).toBeNull();
    expect(dockBlock(a({ status: "working" }))).toBeNull();
  });
  it("tells a usage limit from an error, and a limit wins", () => {
    expect(dockBlock(a({ status: "error" }))!.kind).toBe("error");
    expect(dockBlock(a({ status: "error", rateLimited: true }))!.kind).toBe("usage_limit");
    expect(dockBlock(a({ status: "idle", rateLimited: true }))!.kind).toBe("usage_limit");
  });
  it("offers Resume for a shut-down agent and flags a helper's merge conflict", () => {
    expect(dockBlock(a({ status: "interrupted" }))!.kind).toBe("interrupted");
    expect(dockBlock(a({ status: "stopped", rateLimited: true }))!.kind).toBe("stopped");
    expect(dockBlock(a({ parentId: "m", helperSync: { state: "conflict" } }))!.kind).toBe("conflict");
    expect(dockBlock(a({ helperSync: { state: "conflict" } }))).toBeNull();
  });
});

describe("plan progress", () => {
  const e = (status: PlanEntry["status"], content: string = status): PlanEntry => ({ content, status, priority: null });
  it("counts steps and names the current one (in progress, else the first not done)", () => {
    const p = planProgress({ entries: [e("completed"), e("in_progress", "Validate"), e("pending")] })!;
    expect(p).toMatchObject({ done: 1, total: 3, current: "Validate", complete: false });
    expect(planProgress({ entries: [e("completed"), e("pending", "Next")] })!.current).toBe("Next");
    expect(planProgress({ entries: [e("completed"), e("completed")] })!).toMatchObject({ complete: true, current: null });
    expect(planProgress({ entries: [] })).toBeNull();
    expect(planProgress(undefined)).toBeNull();
  });
  it("shows an unfinished plan only for a live turn of a working agent", () => {
    const p = planProgress({ entries: [e("completed"), e("pending")] });
    expect(planPhase(p, { live: true, busy: true, lingering: false })).toBe("active");
    expect(planPhase(p, { live: true, busy: false, lingering: false })).toBeNull();
    expect(planPhase(p, { live: false, busy: true, lingering: false })).toBeNull();
  });
  it("lingers about four seconds once complete, and only after it was shown active", () => {
    const done = planProgress({ entries: [e("completed")] });
    expect(planPhase(done, { live: true, busy: true, lingering: false })).toBeNull();
    expect(planPhase(done, { live: true, busy: true, lingering: true })).toBe("done");
    expect(lingerStarts(true, null, done)).toBe(true);
    expect(lingerStarts(false, null, done)).toBe(false);
    expect(lingerStarts(true, "active", planProgress({ entries: [e("pending")] }))).toBe(false);
  });
  it("finds the newest plan, and knows whether it belongs to the current turn", () => {
    const items = [
      { kind: "user_message", id: "u", text: "go" },
      { kind: "plan", id: "p1", entries: [] },
      { kind: "plan", id: "p2", entries: [] },
    ] as unknown as TimelineItem[];
    expect(latestPlan(items)!.id).toBe("p2");
    expect(planIsLive(items)).toBe(true);
    expect(planIsLive([...items, { kind: "user_message", id: "u2", text: "next" } as TimelineItem])).toBe(false);
    // A message typed into the running turn doesn't start a new one.
    expect(planIsLive([...items, { kind: "user_message", id: "u3", text: "also", midTurn: true } as TimelineItem])).toBe(true);
  });
});

describe("usage limit wording", () => {
  it("lifts the reset time out of the provider's message", () => {
    expect(resetClause("Usage limit reached for Claude Max (Work). It resets at 3:00 PM.")).toBe("Resets at 3:00 PM");
    expect(resetClause("Limit hit, resets in 2 hours")).toBe("Resets in 2 hours");
    expect(resetClause("Rate limited")).toBeNull();
    expect(withoutReset("Usage limit reached. It resets at 3:00 PM.")).toBe("Usage limit reached.");
  });
});

describe("subagentHeadline", () => {
  it("names the one task, or counts several", () => {
    expect(subagentHeadline([{ description: "Find the router" }])).toBe("Find the router");
    expect(subagentHeadline([{ description: "a" }, { description: "b" }])).toBe("2 sub-agents");
  });
});
