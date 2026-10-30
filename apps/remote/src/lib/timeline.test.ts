import { describe, expect, it } from "vitest";
import { applyDelta, applyTextDelta, isAtLeastAsComplete, mergeSnapshot, upsertItem, type BufferedEvent } from "./timeline";
import type { TimelineItem } from "./types";

const msg = (id: string, seq: number, text: string): TimelineItem => ({ id, agentId: "a", seq, ts: 0, kind: "agent_message", text });
const tool = (id: string, seq: number, status: "pending" | "in_progress" | "completed", output: string): TimelineItem => ({
  id,
  agentId: "a",
  seq,
  ts: 0,
  kind: "tool_call",
  toolCallId: id,
  title: "t",
  toolKind: "execute",
  status,
  locations: [],
  diffs: [],
  output,
  command: null,
});
const delta = (itemId: string, offset: number, d: string, field: "text" | "output" = "text"): BufferedEvent => ({
  type: "text_delta",
  itemId,
  field,
  delta: d,
  offset,
});

describe("applyTextDelta", () => {
  it("appends at the end", () => expect(applyTextDelta("Hel", 3, "lo")).toEqual({ text: "Hello", outcome: "applied" }));
  it("skips a chunk it already has", () => expect(applyTextDelta("Hello", 3, "lo")).toEqual({ text: "Hello", outcome: "duplicate" }));
  it("replaces a diverging tail", () => expect(applyTextDelta("Help!", 3, "lo")).toEqual({ text: "Hello", outcome: "applied" }));
  it("reports a gap instead of guessing", () => expect(applyTextDelta("He", 3, "lo")).toEqual({ text: "He", outcome: "gap" }));
  it("rejects nonsense offsets", () => expect(applyTextDelta("He", -1, "x").outcome).toBe("gap"));
  it("counts UTF-16 units like the server", () => {
    const s = "😀"; // 2 UTF-16 units
    expect(applyTextDelta(s, 2, "!")).toEqual({ text: "😀!", outcome: "applied" });
  });
});

describe("applyDelta", () => {
  it("streams tool output", () => {
    const r = applyDelta([tool("t", 1, "in_progress", "ab")], { itemId: "t", field: "output", delta: "c", offset: 2 });
    expect(r.outcome).toBe("applied");
    expect((r.items[0] as { output: string }).output).toBe("abc");
  });
  it("is a gap for an unknown item", () => {
    expect(applyDelta([], { itemId: "x", field: "text", delta: "a", offset: 0 }).outcome).toBe("gap");
  });
  it("applies each chunk exactly once when replayed", () => {
    let items = [msg("m", 1, "")];
    const chunks = [delta("m", 0, "Hel"), delta("m", 3, "lo"), delta("m", 5, " world")];
    for (const c of [...chunks, ...chunks]) items = applyDelta(items, c as never).items;
    expect((items[0] as { text: string }).text).toBe("Hello world");
  });
});

describe("mergeSnapshot", () => {
  it("does not duplicate text the snapshot already contains (the old corruption bug)", () => {
    // Deltas "Hel" + "lo" arrived while the fetch ran; the snapshot was taken after "Hel".
    const buffered = [delta("m", 0, "Hel"), delta("m", 3, "lo")];
    const { items, gap } = mergeSnapshot([msg("m", 1, "Hel")], buffered);
    expect(gap).toBe(false);
    expect((items[0] as { text: string }).text).toBe("Hello");
  });

  it("keeps a snapshot item that is newer than a buffered upsert", () => {
    const { items } = mergeSnapshot([msg("m", 1, "Hello world")], [{ type: "item_upserted", item: msg("m", 1, "Hello") }]);
    expect((items[0] as { text: string }).text).toBe("Hello world");
  });

  it("takes a buffered upsert that is further along", () => {
    const { items } = mergeSnapshot(
      [tool("t", 1, "in_progress", "a")],
      [{ type: "item_upserted", item: tool("t", 1, "completed", "abc") }],
    );
    expect(items[0]).toMatchObject({ status: "completed", output: "abc" });
  });

  it("adds new items in seq order and applies their deltas", () => {
    const { items, gap } = mergeSnapshot(
      [msg("a", 1, "x"), msg("c", 3, "z")],
      [{ type: "item_upserted", item: msg("b", 2, "") }, delta("b", 0, "y")],
    );
    expect(gap).toBe(false);
    expect(items.map((i) => (i as { text: string }).text)).toEqual(["x", "y", "z"]);
  });

  it("flags a gap it can't reconcile", () => {
    expect(mergeSnapshot([msg("m", 1, "He")], [delta("m", 5, "!")]).gap).toBe(true);
  });
});

describe("isAtLeastAsComplete", () => {
  const perm = (resolution: string | null): TimelineItem => ({
    id: "p",
    agentId: "a",
    seq: 1,
    ts: 0,
    kind: "permission",
    requestId: "r",
    title: "t",
    toolKind: null,
    command: null,
    diffs: [],
    options: [],
    resolution,
  });
  it("never un-resolves a permission", () => {
    expect(isAtLeastAsComplete(perm(null), perm("allow"))).toBe(false);
    expect(isAtLeastAsComplete(perm("allow"), perm(null))).toBe(true);
  });
  it("orders tool progress", () => {
    expect(isAtLeastAsComplete(tool("t", 1, "in_progress", "abc"), tool("t", 1, "completed", ""))).toBe(false);
  });
});

describe("upsertItem", () => {
  it("keeps seq order", () => {
    const items = upsertItem([msg("a", 1, ""), msg("c", 3, "")], msg("b", 2, ""));
    expect(items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});

describe("question merge", () => {
  const q = (resolution: string | null): TimelineItem => ({ id: "q", agentId: "a", seq: 1, ts: 1, kind: "question", requestId: "r", message: "?", fields: [], resolution });
  it("a pending upsert never replaces a resolved snapshot copy", () => {
    expect(isAtLeastAsComplete(q(null), q("answered"))).toBe(false);
    expect(isAtLeastAsComplete(q("answered"), q(null))).toBe(true);
    expect(mergeSnapshot([q("skipped")], [{ type: "item_upserted", item: q(null) }]).items[0]).toMatchObject({ resolution: "skipped" });
  });
});
