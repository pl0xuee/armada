import { describe, expect, it } from "vitest";
import { buildRows, isSubagentNode, latestChild, runningSubagents } from "./rows";
import type { TimelineItem, ToolCallItem } from "./types";

let seq = 0;
function call(id: string, extra: Partial<ToolCallItem> = {}): ToolCallItem {
  seq++;
  return {
    id,
    agentId: "a",
    seq,
    ts: seq,
    kind: "tool_call",
    toolCallId: `tc-${id}`,
    title: id,
    toolKind: "read",
    status: "completed",
    locations: [],
    diffs: [],
    output: "",
    command: null,
    ...extra,
  };
}
const msg = (id: string): TimelineItem => ({ id, agentId: "a", seq: ++seq, ts: seq, kind: "agent_message", text: id });

describe("buildRows", () => {
  it("stacks consecutive tool calls and breaks on other items", () => {
    const rows = buildRows([call("a"), call("b"), msg("m"), call("c")]);
    expect(rows.map((r) => (r.kind === "tools" ? r.tools.map((t) => t.id).join("+") : r.kind))).toEqual(["a+b", "item", "c"]);
  });

  it("nests a sub-agent's calls under it, out of the main flow", () => {
    const parent = call("p", { subagent: { kind: "Explore", description: "Audit" }, status: "in_progress" });
    const items = [
      call("before"),
      parent,
      call("c1", { parentToolCallId: "tc-p" }),
      msg("m"),
      call("c2", { parentToolCallId: "tc-p", status: "in_progress" }),
      call("after"),
    ];
    const rows = buildRows(items);
    expect(rows.map((r) => r.kind)).toEqual(["tools", "subagent", "item", "tools"]);
    const sub = rows[1];
    if (sub.kind !== "subagent") throw new Error("expected sub-agent row");
    expect(sub.node.children.map((c) => (isSubagentNode(c) ? c.call.id : c.id))).toEqual(["c1", "c2"]);
    expect(sub.node.total).toBe(2);
    expect(latestChild(sub.node)?.id).toBe("c2");
    expect(runningSubagents(items)).toBe(1);
  });

  it("nests sub-agents inside sub-agents and counts every descendant", () => {
    const outer = call("o", { subagent: { kind: "general-purpose" } });
    const inner = call("i", { subagent: { kind: "Explore" }, parentToolCallId: "tc-o" });
    const rows = buildRows([outer, inner, call("x", { parentToolCallId: "tc-i" }), call("y", { parentToolCallId: "tc-o" })]);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    if (r.kind !== "subagent") throw new Error("expected sub-agent row");
    expect(r.node.total).toBe(3);
    const first = r.node.children[0];
    expect(isSubagentNode(first) && first.children.length).toBe(1);
  });

  it("keeps calls whose parent isn't in the timeline inline", () => {
    const rows = buildRows([call("orphan", { parentToolCallId: "tc-missing" })]);
    expect(rows).toEqual([{ kind: "tools", key: "orphan", tools: [expect.objectContaining({ id: "orphan" })] }]);
  });

  it("doesn't nest under a call that isn't a sub-agent, or under itself", () => {
    const rows = buildRows([call("plain"), call("child", { parentToolCallId: "tc-plain" }), call("self", { subagent: {}, parentToolCallId: "tc-self" })]);
    expect(rows.map((r) => r.kind)).toEqual(["tools", "subagent"]);
  });
});

describe("row identity and estimates", () => {
  it("treats rebuilt rows over the same items as equal", async () => {
    const { sameRow, estimateRow } = await import("./rows");
    const items = [call("a"), call("b"), msg("m")];
    const r1 = buildRows(items);
    const r2 = buildRows(items.slice());
    expect(r1.every((r, i) => sameRow(r, r2[i]))).toBe(true);
    const changed = buildRows([items[0], { ...items[1] } as TimelineItem, items[2]]);
    expect(sameRow(r1[0], changed[0])).toBe(false);
    expect(sameRow(r1[1], changed[1])).toBe(true);
    for (const r of r1) expect(estimateRow(r)).toBeGreaterThan(30);
  });
});
