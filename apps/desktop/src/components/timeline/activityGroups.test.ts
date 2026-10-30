import { describe, expect, it } from "vitest";
import type { TimelineItem } from "@/lib/types";
import { groupActivity, nextKeep } from "./activityGroups";

let n = 0;
const base = () => ({ id: `i${n++}`, ts: 0 });
const tool = (extra: object = {}) =>
  ({
    ...base(),
    kind: "tool_call",
    toolCallId: `t${n}`,
    title: "x",
    toolKind: "read",
    status: "completed",
    locations: [],
    diffs: [],
    output: "",
    command: null,
    ...extra,
  }) as unknown as TimelineItem;
const user = () => ({ ...base(), kind: "user_message", text: "hi" }) as unknown as TimelineItem;
const msg = () => ({ ...base(), kind: "agent_message", text: "ok" }) as unknown as TimelineItem;
const pic = () =>
  ({ ...base(), kind: "agent_message", text: "", images: [{ name: "i.png", mimeType: "image/png", data: "AAAA" }] }) as unknown as TimelineItem;
const thought = () => ({ ...base(), kind: "thought", text: "hm" }) as unknown as TimelineItem;
const perm = (resolution: string | null) =>
  ({
    ...base(),
    kind: "permission",
    requestId: "r",
    title: "p",
    toolKind: null,
    command: null,
    diffs: [],
    options: [],
    resolution,
  }) as unknown as TimelineItem;

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
    expect(g.groups.get(1)).toEqual([1, 2]);
    expect(g.groups.get(4)).toEqual([4, 5]);
  });
  it("a subagent call breaks the run", () => {
    const g = run([tool(), tool(), tool({ subagent: { name: "a" } }), tool(), tool()]);
    expect(g.rows).toEqual([0, 2, 3]);
  });
  it("does not group a single item", () => {
    const g = run([user(), tool(), msg()]);
    expect(g.groups.size).toBe(0);
    expect(g.rows).toEqual([0, 1, 2]);
  });
});

describe("pictures in replies", () => {
  it("never fold into a group, and don't replace the text as the turn's answer", () => {
    // tool, tool, picture, tool, text answer: the picture stays a row of its own.
    const items = [user(), tool(), tool(), pic(), tool(), tool(), msg()];
    const g = run(items);
    expect(g.rows.includes(3)).toBe(true);
    for (const members of g.groups.values()) expect(members.includes(3)).toBe(false);
    // text answer, then a picture: the text is still the answer (not folded away).
    const after = [user(), tool(), tool(), msg(), pic()];
    const g2 = run(after);
    expect(g2.rows).toContain(3);
    expect(g2.rows).toContain(4);
  });
});

describe("waiting on sub-agents", () => {
  it("folds even a single trailing call so it doesn't pop in and out", () => {
    const items = [user(), tool({ subagent: { kind: "Explore" } }), tool()];
    const top = items.map((_, i) => i);
    expect(groupActivity(items, top).groups.size).toBe(0);
    const folded = groupActivity(items, top, { foldTail: true });
    expect(folded.rows).toEqual([0, 1, 2]);
    expect(folded.groups.get(2)).toEqual([2]);
  });
  it("leaves earlier single calls alone", () => {
    const items = [user(), tool(), tool({ subagent: { kind: "Explore" } })];
    const folded = groupActivity(
      items,
      items.map((_, i) => i),
      { foldTail: true },
    );
    expect(folded.groups.size).toBe(0);
  });
});

describe("keep (sticky unfolded rows)", () => {
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
  it("releases rows fully above the viewport when pinned", () => {
    const prev = new Set(["a"]);
    const lookup = () => ({ start: 500, end: 700 });
    expect(nextKeep(prev, [], lookup, view, true).size).toBe(0);
  });
  it("holds rows above the viewport while the reader is scrolled up", () => {
    const prev = new Set(["a"]);
    const lookup = () => ({ start: 500, end: 700 });
    expect(nextKeep(prev, [], lookup, view, false)).toBe(prev);
  });
  it("treats rows within the margin as visible", () => {
    const prev = new Set(["a"]);
    expect(nextKeep(prev, [], () => ({ start: 800, end: 950 }), view, true)).toBe(prev);
  });
  it("releases rows below the viewport even when not pinned", () => {
    expect(nextKeep(new Set(["a"]), [], () => ({ start: 2500, end: 2700 }), view, false).size).toBe(0);
  });
});
