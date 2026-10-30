import { describe, expect, it } from "vitest";
import { currentStep, groupActivity, nextKeep, openGroupKeys, summarizeActivity } from "./activity";
import type { TimelineItem } from "./types";

let n = 0;
const base = () => ({ id: `i${n++}`, ts: 0 });
const tool = (extra: object = {}) =>
  ({ ...base(), kind: "tool_call", toolCallId: `t${n}`, title: "x", toolKind: "read", status: "completed", locations: [], diffs: [], output: "", command: null, ...extra }) as unknown as TimelineItem;
const user = () => ({ ...base(), kind: "user_message", text: "hi" }) as unknown as TimelineItem;
const msg = (text = "ok") => ({ ...base(), kind: "agent_message", text }) as unknown as TimelineItem;
const pic = () => ({ ...base(), kind: "agent_message", text: "", images: [{ name: "i.png", mimeType: "image/png", data: "AAAA" }] }) as unknown as TimelineItem;
const thought = () => ({ ...base(), kind: "thought", text: "hm" }) as unknown as TimelineItem;
const perm = (resolution: string | null) =>
  ({ ...base(), kind: "permission", requestId: "r", title: "p", toolKind: null, command: null, diffs: [], options: [], resolution }) as unknown as TimelineItem;

const run = (items: TimelineItem[]) =>
  groupActivity(
    items,
    items.map((_, i) => i),
  );

describe("groupActivity", () => {
  it("groups a run of tool calls and thoughts", () => {
    const g = run([user(), tool(), thought(), tool(), msg()]);
    expect(g.rows).toEqual([0, 1, 4]);
    expect(g.groups.get(1)).toEqual([1, 2, 3]);
  });
  it("keeps the last agent message of the turn out, groups earlier ones", () => {
    const g = run([user(), tool(), msg(), tool(), msg()]);
    expect(g.groups.get(1)).toEqual([1, 2, 3]);
    expect(g.rows).toEqual([0, 1, 4]);
  });
  it("keeps the latest interim message visible while later tool calls stream in", () => {
    const g = run([user(), tool(), tool(), msg(), tool(), tool()]);
    expect(g.rows).toEqual([0, 1, 3, 4]);
    expect(g.groups.get(4)).toEqual([4, 5]);
  });
  it("a pending permission breaks the run", () => {
    const g = run([user(), tool(), tool(), perm(null), tool(), tool()]);
    expect(g.rows).toEqual([0, 1, 3, 4]);
  });
  it("a sub-agent launch breaks the run, but a control call doesn't", () => {
    expect(run([tool(), tool(), tool({ subagent: { kind: "a" } }), tool(), tool()]).rows).toEqual([0, 2, 3]);
    const g = run([tool(), tool({ subagent: { kind: "wait", control: true } }), tool()]);
    expect(g.groups.get(0)).toEqual([0, 1, 2]);
  });
  it("does not group a single item", () => {
    const g = run([user(), tool(), msg()]);
    expect(g.groups.size).toBe(0);
    expect(g.rows).toEqual([0, 1, 2]);
  });
  it("pictures never fold into a group and don't replace the text as the turn's answer", () => {
    const g = run([user(), tool(), tool(), pic(), tool(), tool(), msg()]);
    expect(g.rows.includes(3)).toBe(true);
    for (const members of g.groups.values()) expect(members.includes(3)).toBe(false);
    const g2 = run([user(), tool(), tool(), msg(), pic()]);
    expect(g2.rows).toContain(3);
    expect(g2.rows).toContain(4);
  });
  it("foldTail folds even a single trailing call while only waiting on sub-agents", () => {
    const items = [user(), tool({ subagent: { kind: "Explore" } }), tool()];
    const top = items.map((_, i) => i);
    expect(groupActivity(items, top).groups.size).toBe(0);
    expect(groupActivity(items, top, { foldTail: true }).groups.get(2)).toEqual([2]);
  });
  it("keeps a visible standalone row out of the group", () => {
    const a = tool(), b = tool(), m = msg(), c = tool(), m2 = msg();
    const items = [user(), a, b, m, c, m2];
    const top = items.map((_, i) => i);
    expect(groupActivity(items, top).groups.get(1)).toEqual([1, 2, 3, 4]);
    const g = groupActivity(items, top, { keep: new Set([m.id, c.id]) });
    expect(g.groups.get(1)).toEqual([1, 2]);
    expect(g.rows).toEqual([0, 1, 3, 4, 5]);
  });
});

describe("nextKeep", () => {
  const view = { top: 1000, bottom: 1800 };
  const row = (id: string, start: number, end: number, standalone = true) => ({ id, standalone, start, end });
  const none = () => undefined;
  it("adds tall visible standalone rows only", () => {
    const k = nextKeep(new Set(), [row("a", 1100, 1300), row("b", 1300, 1330), row("g", 1330, 1500, false)], none, view, true);
    expect([...k]).toEqual(["a"]);
  });
  it("releases rows fully above the viewport when pinned, holds them while the reader is scrolled up", () => {
    const prev = new Set(["a"]);
    const lookup = () => ({ start: 500, end: 700 });
    expect(nextKeep(prev, [], lookup, view, true).size).toBe(0);
    expect(nextKeep(prev, [], lookup, view, false)).toBe(prev);
  });
  it("treats rows within the margin as visible", () => {
    const prev = new Set(["a"]);
    expect(nextKeep(prev, [], () => ({ start: 800, end: 950 }), view, true)).toBe(prev);
  });
  it("releases rows below the viewport even when not pinned", () => {
    expect(nextKeep(new Set(["a"]), [], () => ({ start: 2500, end: 2700 }), view, false).size).toBe(0);
  });
  it("holds an unmounted row (unknown position) unless pinned", () => {
    const prev = new Set(["a"]);
    expect(nextKeep(prev, [], none, view, false)).toBe(prev);
    expect(nextKeep(prev, [], none, view, true).size).toBe(0);
  });
});

describe("summarizeActivity", () => {
  it("counts by kind, in the desktop's wording", () => {
    const items = [tool(), tool(), tool({ toolKind: "edit" }), tool({ toolKind: "execute" }), tool({ toolKind: "execute", status: "failed" }), tool({ toolKind: "search" }), thought()];
    expect(summarizeActivity(items)).toEqual({ text: "Read 2 files, edited 1 file, ran 2 commands, 1 search", failed: 1 });
    expect(summarizeActivity([tool({ toolKind: "fetch" }), tool({ toolKind: "other" })]).text).toBe("Fetched 1 page, 1 other tool");
    expect(summarizeActivity([tool({ toolKind: "other" }), tool({ toolKind: "other" })]).text).toBe("Used 2 tools");
    expect(summarizeActivity([tool({ toolKind: "search" })]).text).toBe("Ran 1 search");
    expect(summarizeActivity([tool({ toolKind: "search" }), tool({ toolKind: "search" }), tool({ toolKind: "read" })]).text).toBe("Read 1 file, ran 2 searches");
    expect(summarizeActivity([tool({ toolKind: "execute" }), tool({ toolKind: "search" }), tool({ toolKind: "other" })]).text).toBe("Ran 1 command, 1 search, 1 other tool");
  });
  it("describes groups without tool calls", () => {
    expect(summarizeActivity([thought(), msg()]).text).toBe("Thought for a moment");
    expect(summarizeActivity([msg(), msg()]).text).toBe("2 steps");
  });
});

describe("currentStep", () => {
  it("names what the agent is doing", () => {
    expect(currentStep(tool({ title: "Run tests" }))).toEqual({ kind: "tool", text: "Run tests" });
    expect(currentStep(thought())).toEqual({ kind: "thought", text: "Thinking…" });
    expect(currentStep(msg("**Plan**: do it\nmore"))).toEqual({ kind: "message", text: "Plan: do it" });
    expect(currentStep(msg(""))?.text).toBe("Writing…");
    expect(currentStep(undefined)).toBeNull();
  });
});

describe("openGroupKeys", () => {
  const g = (key: string, ...ids: string[]) => ({ kind: "group", key, items: [key, ...ids].map((id) => ({ id })) });
  it("opens nothing unless the reader opened it", () => {
    expect(openGroupKeys([g("a", "a2")], new Set()).size).toBe(0);
  });
  it("keeps an opened group open when runs merge and its key changes", () => {
    const merged = g("a", "a2", "k", "b", "b2"); // "b" was the opened group before the run merged into "a"
    expect([...openGroupKeys([merged], new Set(["b"]))]).toEqual(["a"]);
    expect([...openGroupKeys([{ kind: "item", key: "x" }, g("a", "a2"), g("c", "c2")], new Set(["c"]))]).toEqual(["c"]);
  });
});
