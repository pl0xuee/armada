import { describe, expect, it } from "vitest";
import { buildRows, estimateRow, finalAnswerIds, isPictureOnly, isSubagentNode, latestChild, withoutResumeNotice } from "./rows";
import type { Attachment, TimelineItem, ToolCallItem } from "./types";

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
const img: Attachment = { name: "p.png", mimeType: "image/png", data: "AAAA" };
const pic = (id: string, text = ""): TimelineItem => ({ id, agentId: "a", seq: ++seq, ts: seq, kind: "agent_message", text, images: [img] });
const user = (id: string): TimelineItem => ({ id, agentId: "a", seq: ++seq, ts: seq, kind: "user_message", text: id });

describe("buildRows", () => {
  it("folds consecutive tool calls into one group and breaks on other items", () => {
    const rows = buildRows([call("a"), call("b"), msg("m"), call("c")]);
    expect(rows.map((r) => (r.kind === "group" ? r.items.map((t) => t.id).join("+") : r.kind))).toEqual(["a+b", "item", "tools"]);
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
    expect(rows.map((r) => r.kind)).toEqual(["group", "subagent"]);
  });

  it("treats Codex wait/close control calls as plain tool calls, not sub-agent cards", () => {
    const launch = call("launch", { subagent: { kind: "worker" } });
    const wait = call("wait", { subagent: { kind: "wait", control: true } });
    const rows = buildRows([launch, call("child", { parentToolCallId: "tc-launch" }), wait]);
    expect(rows.map((r) => r.kind)).toEqual(["subagent", "tools"]);
    // A control call is never a launcher: calls naming it as parent stay inline.
    const orphan = buildRows([wait, call("x", { parentToolCallId: "tc-wait" })]);
    expect(orphan.map((r) => r.kind)).toEqual(["group"]);
  });
});

describe("activity groups in rows", () => {
  it("folds runs of tool calls and keeps every message in view", () => {
    const items = [user("u"), call("r1"), call("r2", { toolKind: "execute" }), msg("narration"), call("r3"), msg("answer")];
    const rows = buildRows(items);
    expect(rows.map((r) => r.kind)).toEqual(["item", "group", "item", "tools", "item"]);
    const g = rows[1];
    expect(g.kind === "group" && g.items.map((i) => i.id)).toEqual(["r1", "r2"]);
    expect(rows[4].key).toBe("answer");
  });

  it("keeps a picture-only reply as its own row and never as the final answer", () => {
    const items = [user("u"), call("a"), call("b"), msg("answer"), pic("p")];
    const rows = buildRows(items);
    expect(rows.map((r) => r.key)).toEqual(["u", "a", "answer", "p"]);
    expect(rows[1].kind).toBe("group");
  });

  it("compares groups by their member objects", async () => {
    const { sameRow } = await import("./rows");
    const items = [call("a"), call("b")];
    const [g1] = buildRows(items);
    expect(sameRow(g1, buildRows(items.slice())[0])).toBe(true);
    expect(sameRow(g1, buildRows([items[0], { ...items[1] } as TimelineItem])[0])).toBe(false);
    expect(estimateRow(g1)).toBeGreaterThan(30);
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

describe("question rows", () => {
  it("renders a question as its own item row between tool stacks", () => {
    const q: TimelineItem = { id: "q", agentId: "a", seq: ++seq, ts: seq, kind: "question", requestId: "r", message: "?", fields: [], resolution: null };
    const rows = buildRows([call("a"), q, call("b")]);
    expect(rows.map((r) => r.kind)).toEqual(["tools", "item", "tools"]);
    expect(estimateRow(rows[1])).toBeGreaterThan(estimateRow({ kind: "item", key: "q", item: { ...q, resolution: "skipped" } as TimelineItem }));
  });
});

describe("pictures in replies", () => {
  it("keeps a picture-only reply as a row of its own", () => {
    const rows = buildRows([msg("m1"), pic("p"), call("t")]);
    expect(rows.map((r) => r.kind)).toEqual(["item", "item", "tools"]);
  });

  it("recognises picture-only replies", () => {
    expect(isPictureOnly(pic("p"))).toBe(true);
    expect(isPictureOnly(pic("p", "  \n"))).toBe(true);
    expect(isPictureOnly(pic("p", "caption"))).toBe(false);
    expect(isPictureOnly(msg("m"))).toBe(false);
    expect(isPictureOnly({ ...msg("m"), text: "", images: [] } as TimelineItem)).toBe(false);
    expect(isPictureOnly(call("c"))).toBe(false);
    expect(isPictureOnly(undefined)).toBe(false);
  });

  it("makes the last text of each turn its answer; a picture after it doesn't replace it", () => {
    const items = [user("u1"), msg("n1"), call("t"), msg("answer1"), pic("p1"), user("u2"), msg("n2"), msg("answer2"), pic("p2")];
    expect([...finalAnswerIds(items)].sort()).toEqual(["answer1", "answer2"]);
    // A picture with a caption is a normal message and can be the answer.
    expect([...finalAnswerIds([user("u"), msg("a"), pic("cap", "caption")])]).toEqual(["cap"]);
    // A turn that produced only a picture has no text answer.
    expect([...finalAnswerIds([user("u"), pic("p")])]).toEqual([]);
  });

  it("estimates the height of pictures, and no text height for an empty caption", () => {
    const [text] = buildRows([msg("hello")]);
    const [withPic] = buildRows([pic("p", "hello")]);
    const [only] = buildRows([pic("p")]);
    expect(estimateRow(withPic)).toBeGreaterThan(estimateRow(text) + 150);
    expect(estimateRow(only)).toBeGreaterThan(150);
    expect(estimateRow(only)).toBeLessThan(estimateRow(withPic));
  });
});

describe("withoutResumeNotice", () => {
  const notice = (text: string) => ({ id: text, agentId: "a", seq: 1, ts: 1, kind: "notice", level: "warn", text }) as unknown as TimelineItem;
  const items = [notice("Armada closed while this agent was working. Resume to pick up where it left off."), notice("Stopped by you")];
  it("hides the resume notice while interrupted, so the banner isn't repeated", () => {
    expect(withoutResumeNotice(items, "interrupted").map((i) => i.id)).toEqual(["Stopped by you"]);
  });
  it("keeps everything otherwise (and returns the same array)", () => {
    expect(withoutResumeNotice(items, "idle")).toBe(items);
    expect(withoutResumeNotice([items[1]], "interrupted")).toEqual([items[1]]);
  });
});
