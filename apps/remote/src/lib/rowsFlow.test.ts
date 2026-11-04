import { describe, expect, it } from "vitest";
import { buildRows, estimateRow, finalAnswerIds, latestAnswer, messageRowText, sameRow } from "./rows";
import type { TimelineItem } from "./types";

let n = 0;
const base = () => ({ id: `i${++n}`, agentId: "a", seq: n, ts: n });
const msg = (text: string) => ({ ...base(), kind: "agent_message", text }) as unknown as TimelineItem;
const user = (text = "go") => ({ ...base(), kind: "user_message", text }) as unknown as TimelineItem;
const perm = () =>
  ({ ...base(), kind: "permission", requestId: "r", title: "x", options: [], diffs: [], resolution: null }) as unknown as TimelineItem;
const call = (extra: object = {}) =>
  ({
    ...base(),
    kind: "tool_call",
    toolCallId: `t${n}`,
    title: "Read x",
    toolKind: "read",
    status: "completed",
    locations: [],
    diffs: [],
    output: "",
    command: null,
    ...extra,
  }) as unknown as TimelineItem;

describe("buildRows stitches adjacent messages", () => {
  it("keeps messages apart when a sub-agent card shows between them", () => {
    const launcher = call({ toolCallId: "p", subagent: { kind: "Explore" } });
    const rows = buildRows([user(), msg("Before the sub-agent"), launcher, msg("After it")]);
    expect(rows.map((r) => r.kind)).toEqual(["item", "item", "subagent", "item"]);
  });
  it("merges messages that touch, with the first one's id as the row key", () => {
    const a = msg("first half of a sentence");
    const b = msg(" and the second half."); // the stream carries its own spaces
    const rows = buildRows([user(), a, b]);
    expect(rows).toHaveLength(2);
    const row = rows[1];
    expect(row.kind).toBe("message");
    if (row.kind !== "message") return;
    expect(row.key).toBe(a.id);
    expect(messageRowText(row)).toBe("first half of a sentence and the second half.");
  });
  it("keeps messages apart when a tool call shows between them", () => {
    const rows = buildRows([user(), msg("a"), call(), msg("b")]);
    expect(rows.some((r) => r.kind === "message")).toBe(false);
  });
  it("recognises an unchanged run and a grown one", () => {
    const a = msg("one");
    const b = msg("two");
    const c = msg("three");
    const r1 = buildRows([user(), a, b])[1];
    const r2 = buildRows([user(), a, b])[1];
    const r3 = buildRows([user(), a, b, c])[1];
    expect(sameRow(r1, r2)).toBe(true);
    expect(sameRow(r1, r3)).toBe(false);
    expect(estimateRow(r1)).toBeGreaterThan(16);
  });
});

describe("latestAnswer", () => {
  it("finds the closing message of the latest turn", () => {
    const items = [user(), msg("old"), user(), msg("note"), msg("answer")];
    const finals = finalAnswerIds(items);
    expect(latestAnswer(items, finals)).toEqual({ id: items[4].id, trailingActivity: false });
  });
  it("notes tool calls, thoughts or approvals that follow it in its turn", () => {
    const items = [user(), msg("looking"), call()];
    expect(latestAnswer(items, finalAnswerIds(items))).toEqual({ id: items[1].id, trailingActivity: true });
    const waiting = [user(), msg("ok?"), perm()];
    expect(latestAnswer(waiting, finalAnswerIds(waiting)).trailingActivity).toBe(true);
  });
  it("does not look past the next user message, and copes with no answer", () => {
    const items = [user(), msg("done"), user()];
    expect(latestAnswer(items, finalAnswerIds(items)).trailingActivity).toBe(false);
    expect(latestAnswer([user()], new Set())).toEqual({ id: null, trailingActivity: false });
  });
});
