import { describe, expect, it } from "vitest";
import type { Agent, TimelineItem } from "@/lib/types";
import { seedAgents } from "@/lib/mock-data";
import { applyDelta, applyInPlace, insertBySeq, reduceItems, sameAgent, type TextDelta } from "./app";

const msg = (id: string, seq: number, text: string): TimelineItem => ({
  id,
  agentId: "a",
  seq,
  ts: seq,
  kind: "agent_message",
  text,
});

const tool = (id: string, seq: number, output: string): TimelineItem => ({
  id,
  agentId: "a",
  seq,
  ts: seq,
  kind: "tool_call",
  toolCallId: id,
  title: "Run",
  toolKind: "execute",
  status: "in_progress",
  locations: [],
  diffs: [],
  output,
  command: "npm test",
});

const delta = (itemId: string, d: string, offset: number, field: "text" | "output" = "text"): TextDelta => ({
  type: "text_delta",
  agentId: "a",
  itemId,
  field,
  delta: d,
  offset,
});

const textOf = (it: TimelineItem) => (it.kind === "agent_message" ? it.text : it.kind === "tool_call" ? it.output : "");

describe("applyDelta (offset rules)", () => {
  it("appends when the offset equals the current length", () => {
    const r = applyDelta(msg("m", 1, "Hello "), delta("m", "world", 6));
    expect(textOf(r.item)).toBe("Hello world");
    expect(r.gap).toBe(false);
  });

  it("skips an exact duplicate (offset < length and the text already matches)", () => {
    const item = msg("m", 1, "Hello world");
    const r = applyDelta(item, delta("m", "world", 6));
    expect(r.item).toBe(item);
    expect(r.gap).toBe(false);
  });

  it("overwrites from the offset when the text differs", () => {
    const r = applyDelta(msg("m", 1, "Hello world"), delta("m", "there", 6));
    expect(textOf(r.item)).toBe("Hello there");
  });

  it("reports a gap (and changes nothing) when the offset is past the end", () => {
    const item = msg("m", 1, "Hi");
    const r = applyDelta(item, delta("m", "!!", 10));
    expect(r.item).toBe(item);
    expect(r.gap).toBe(true);
  });

  it("applies output deltas to tool calls and ignores mismatched fields", () => {
    expect(textOf(applyDelta(tool("t", 1, "a"), delta("t", "b", 1, "output")).item)).toBe("ab");
    const m = msg("m", 1, "x");
    expect(applyDelta(m, delta("m", "y", 1, "output")).item).toBe(m);
  });

  it("counts offsets in UTF-16 code units (JS string length)", () => {
    const r = applyDelta(msg("m", 1, "🙂"), delta("m", "!", 2));
    expect(textOf(r.item)).toBe("🙂!");
  });
});

describe("reduceItems / insertBySeq", () => {
  it("inserts upserts in seq order and replaces by id", () => {
    let list = [msg("a", 1, "1"), msg("c", 3, "3")];
    list = insertBySeq(list, msg("b", 2, "2"));
    expect(list.map((i) => i.id)).toEqual(["a", "b", "c"]);
    list = insertBySeq(list, msg("b", 2, "two"));
    expect(list.map(textOf)).toEqual(["1", "two", "3"]);
  });

  it("returns the same list (no copy) for a duplicate delta", () => {
    const list = [msg("m", 1, "abc")];
    const r = reduceItems(list, delta("m", "bc", 1));
    expect(r.list).toBe(list);
  });

  it("treats a delta for an unknown item as a gap", () => {
    expect(reduceItems([msg("m", 1, "")], delta("zzz", "x", 0)).gap).toBe(true);
  });

  it("is idempotent for repeated upserts", () => {
    const item = msg("m", 1, "done");
    const once = reduceItems([], { type: "item_upserted", item }).list;
    const twice = reduceItems(once, { type: "item_upserted", item }).list;
    expect(twice).toEqual(once);
  });
});

describe("applyInPlace (per-batch mutation)", () => {
  it("applies a burst of deltas to one copy", () => {
    const list = [msg("m", 1, "")];
    let gap = false;
    ["The ", "quick ", "fox"].reduce((off, d) => {
      gap ||= applyInPlace(list, delta("m", d, off));
      return off + d.length;
    }, 0);
    expect(textOf(list[0])).toBe("The quick fox");
    expect(gap).toBe(false);
  });

  it("keeps seq order for out-of-order upserts and flags gaps", () => {
    const list = [msg("a", 1, ""), msg("c", 3, "")];
    applyInPlace(list, { type: "item_upserted", item: msg("b", 2, "") });
    expect(list.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(applyInPlace(list, delta("b", "x", 5))).toBe(true);
  });
});

describe("sameAgent", () => {
  const a: Agent = seedAgents()[0];
  it("ignores updatedAt", () => {
    expect(sameAgent(a, { ...a, updatedAt: a.updatedAt + 1 })).toBe(true);
  });
  it("detects field and nested changes", () => {
    expect(sameAgent(a, { ...a, costUsd: a.costUsd + 1 })).toBe(false);
    expect(sameAgent(a, { ...a, queue: [{ id: "q", text: "x", attachments: 0 }] })).toBe(false);
    expect(sameAgent(a, { ...a, configOptions: JSON.parse(JSON.stringify(a.configOptions)) })).toBe(true);
  });
});
