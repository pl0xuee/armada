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
