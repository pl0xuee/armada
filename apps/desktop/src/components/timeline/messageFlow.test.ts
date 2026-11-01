import { describe, expect, it } from "vitest";
import type { KvistcodeEvent, TimelineItem } from "@/lib/types";
import { reduceItems, type ItemEvent } from "@/store/app";
import { joinMessageText, runText, stitchMessages } from "./messageFlow";

let n = 0;
const base = () => ({ id: `i${n++}`, agentId: "a", seq: n, ts: n });
const msg = (text: string, images?: unknown[]) =>
  ({ ...base(), kind: "agent_message", text, ...(images ? { images } : {}) }) as unknown as TimelineItem;
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
const user = () => ({ ...base(), kind: "user_message", text: "go" }) as unknown as TimelineItem;
const pic = () => msg("", [{ name: "a.png", mimeType: "image/png", data: "AAAA" }]);

describe("joinMessageText", () => {
  it("joins a sentence cut in two without a paragraph break", () => {
    expect(joinMessageText("the machine were busy with my compiling", "and testing would distort its numbers.")).toBe(
      "the machine were busy with my compiling and testing would distort its numbers.",
    );
  });

  it("keeps the whitespace the stream already carried", () => {
    expect(joinMessageText("busy with ", "my compiling")).toBe("busy with my compiling");
    expect(joinMessageText("busy with", " my compiling")).toBe("busy with my compiling");
  });

  it("starts a new paragraph after a finished sentence", () => {
    expect(joinMessageText("I'll run the benchmark.", "Then I'll compare.")).toBe(
      "I'll run the benchmark.\n\nThen I'll compare.",
    );
    expect(joinMessageText("Here is the plan:", "First, read it.")).toBe("Here is the plan:\n\nFirst, read it.");
    expect(joinMessageText("It is **done.**", "Next")).toBe("It is **done.**\n\nNext");
    expect(joinMessageText("All good (see `x`.)", "Next")).toBe("All good (see `x`.)\n\nNext");
  });

  it("does not add spacing when a blank line is already there", () => {
    expect(joinMessageText("One\n\n", "Two")).toBe("One\n\nTwo");
    expect(joinMessageText("One", "\n\nTwo")).toBe("One\n\nTwo");
  });

  it("separates blocks that end without punctuation", () => {
    expect(joinMessageText("## Findings", "The cause is rounding.")).toBe("## Findings\n\nThe cause is rounding.");
    expect(joinMessageText("- first item", "Closing words")).toBe("- first item\n\nClosing words");
    expect(joinMessageText("```ts\nlet a\n```", "Then run it")).toBe("```ts\nlet a\n```\n\nThen run it");
  });

  it("joins a list item cut mid-sentence", () => {
    expect(joinMessageText("- rounds each line before", "tax is applied")).toBe(
      "- rounds each line before tax is applied",
    );
  });

  it("ignores empty sides", () => {
    expect(joinMessageText("", "Hello")).toBe("Hello");
    expect(joinMessageText("Hello", "  ")).toBe("Hello");
  });
});

describe("stitchMessages", () => {
  const rows = (items: TimelineItem[]) => items.map((_, i) => i);

  it("merges consecutive messages into one row at the first position", () => {
    const items = [user(), msg("a"), msg("b"), msg("c")];
    const r = stitchMessages(items, rows(items));
    expect(r.rows).toEqual([0, 1]);
    expect(r.runs.get(1)).toEqual([1, 2, 3]);
  });

  it("keeps messages apart when something is shown between them", () => {
    const items = [msg("a"), tool(), msg("b")];
    const r = stitchMessages(items, rows(items));
    expect(r.rows).toEqual([0, 1, 2]);
    expect(r.runs.size).toBe(0);
  });

  it("does not merge across turns or into pictures", () => {
    const items = [msg("a"), user(), msg("b"), pic(), msg("c")];
    const r = stitchMessages(items, rows(items));
    expect(r.rows).toEqual([0, 1, 2, 3, 4]);
    expect(r.runs.size).toBe(0);
  });

  it("merges across rows that are not shown (sub-agent calls, held calls)", () => {
    const items = [
      msg("the numbers would be misleading with my compiling"),
      tool({ parentToolCallId: "p" }),
      msg("and testing."),
    ];
    // The hidden call is not a top-level row, so the two messages touch.
    const top = [0, 2];
    const r = stitchMessages(items, top);
    expect(r.rows).toEqual([0]);
    expect(runText(r.runs.get(0)!.map((i) => items[i]))).toBe(
      "the numbers would be misleading with my compiling and testing.",
    );
  });
});

describe("a streaming reply interrupted by another event", () => {
  it("reads as one sentence once stitched", () => {
    const delta = (itemId: string, delta: string, offset: number): ItemEvent =>
      ({ type: "text_delta", agentId: "a", itemId, field: "text", delta, offset }) as unknown as ItemEvent;
    const first = { ...msg(""), id: "m1", seq: 1 } as TimelineItem;
    let list: TimelineItem[] = [first];
    list = reduceItems(list, delta("m1", "Benchmark it alone, my compiling", 0)).list;
    // A call attributed to a sub-agent lands mid-sentence and ends the stream...
    const child = { ...tool({ parentToolCallId: "p" }), id: "c1", seq: 10 } as TimelineItem;
    list = reduceItems(list, { type: "item_upserted", item: child } as unknown as ItemEvent).list;
    // ...so the rest goes to a new message item.
    list = reduceItems(list, {
      type: "item_upserted",
      item: { ...msg(""), id: "m2", seq: 11 },
    } as unknown as ItemEvent).list;
    list = reduceItems(list, delta("m2", "and testing would distort it.", 0)).list;

    const top = list.map((it, i) => (it.kind === "tool_call" && it.parentToolCallId ? -1 : i)).filter((i) => i >= 0);
    const r = stitchMessages(list, top);
    expect(r.rows).toHaveLength(1);
    expect(runText(r.runs.get(r.rows[0])!.map((i) => list[i]))).toBe(
      "Benchmark it alone, my compiling and testing would distort it.",
    );
  });
});

// Keeps the import used by the type-only event cast above.
export type _Unused = KvistcodeEvent;
