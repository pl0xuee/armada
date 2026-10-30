import { describe, expect, it } from "vitest";
import type { TimelineItem } from "@/lib/types";
import { groupActivity } from "./activityGroups";

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
  it("never folds agent messages: what the agent says stays where it is", () => {
    const g = run([user(), tool(), msg(), tool(), msg()]);
    expect(g.groups.size).toBe(0);
    expect(g.rows).toEqual([0, 1, 2, 3, 4]);
  });
  it("a message splits runs, and each run keeps its own group while later calls stream in", () => {
    const g = run([user(), tool(), tool(), msg(), tool(), tool()]);
    expect(g.rows).toEqual([0, 1, 3, 4]);
    expect(g.groups.get(1)).toEqual([1, 2]);
    expect(g.groups.get(4)).toEqual([4, 5]);
  });
  it("a run only ever grows: the rows before it never change when more calls arrive", () => {
    const items = [user(), tool(), tool(), msg(), tool()];
    const before = run(items);
    const after = run([...items, tool()]);
    expect(before.rows).toEqual([0, 1, 3, 4]);
    expect(after.rows).toEqual([0, 1, 3, 4]);
    expect(after.groups.get(1)).toEqual(before.groups.get(1));
    expect(after.groups.get(4)).toEqual([4, 5]);
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
