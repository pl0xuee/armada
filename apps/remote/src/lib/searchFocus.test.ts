import { describe, expect, it } from "vitest";
import { buildRows, rowKeyForItem } from "./rows";
import { clearSearchFocus, peekSearchFocus, setSearchFocus } from "./searchFocus";
import type { TimelineItem } from "./types";

let seq = 0;
const base = (id: string) => ({ id, agentId: "a1", seq: ++seq, ts: 1000 + seq });
const user = (id: string, text = "hi"): TimelineItem => ({ ...base(id), kind: "user_message", text, attachments: [] }) as TimelineItem;
const agentMsg = (id: string, text = "ok"): TimelineItem => ({ ...base(id), kind: "agent_message", text }) as TimelineItem;
const tool = (id: string, extra: Record<string, unknown> = {}): TimelineItem =>
  ({
    ...base(id),
    kind: "tool_call",
    toolCallId: `tc-${id}`,
    title: "Read x.ts",
    toolKind: "read",
    status: "completed",
    locations: [],
    diffs: [],
    output: "",
    command: null,
    ...extra,
  }) as TimelineItem;

describe("which row shows a search hit", () => {
  const items = [user("u1"), tool("t1"), tool("t2"), tool("t3"), agentMsg("m1"), user("u2"), agentMsg("m2")];
  const rows = buildRows(items);

  it("finds the row of a plain message", () => {
    expect(rowKeyForItem(rows, "u2", 6)).toBe("u2");
    expect(rowKeyForItem(rows, "m2", 7)).toBe("m2");
  });

  it("finds the folded row that holds a tool call", () => {
    const key = rowKeyForItem(rows, "t2", 3);
    expect(key).toBeTruthy();
    expect(rows.find((r) => r.key === key)).toMatchObject({ kind: expect.stringMatching(/group|tools/) });
  });

  it("finds the call under a sub-agent", () => {
    const launcher = tool("sa", { subagent: { kind: "Explore", description: "d" } });
    const child = tool("child", { parentToolCallId: "tc-sa" });
    const r = buildRows([user("u"), launcher, child, agentMsg("m")]);
    expect(rowKeyForItem(r, "child", 3)).toBe(rowKeyForItem(r, "sa", 2));
  });

  it("falls back to the nearest earlier row for an item no row shows, and to null when not loaded back that far", () => {
    const loaded = [user("late", "x"), agentMsg("later")];
    const r = buildRows(loaded);
    const lateSeq = loaded[0].seq;
    expect(rowKeyForItem(r, "gone", lateSeq + 0)).toBe("late");
    expect(rowKeyForItem(r, "older", lateSeq - 5)).toBeNull();
    expect(rowKeyForItem([], "x", 1)).toBeNull();
  });
});

describe("the hand-off from a tapped result", () => {
  it("is for one agent, stays until cleared, and is not given to another", () => {
    setSearchFocus({ agentId: "a1", itemId: "i", seq: 3 });
    expect(peekSearchFocus("a2")).toBeNull();
    expect(peekSearchFocus("a1")).toEqual({ agentId: "a1", itemId: "i", seq: 3 });
    expect(peekSearchFocus("a1")).not.toBeNull(); // a re-render does not lose it
    clearSearchFocus();
    expect(peekSearchFocus("a1")).toBeNull();
  });
});
