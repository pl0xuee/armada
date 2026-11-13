import { describe, expect, it } from "vitest";
import type { TimelineItem } from "@/lib/types";
import { editStats, sumEdits } from "./editStats";

function edit(id: string, oldText: string | null, newText: string | null, unified: string | null = null): TimelineItem {
  return {
    id,
    agentId: "a",
    seq: 0,
    ts: 0,
    kind: "tool_call",
    toolCallId: id,
    title: "Edit",
    toolKind: "edit",
    status: "completed",
    locations: [],
    diffs: [{ path: `${id}.ts`, oldText, newText, unified }],
    output: "",
    command: null,
  };
}

describe("editStats", () => {
  it("is zero without edits", () => {
    expect(sumEdits([])).toEqual({ additions: 0, deletions: 0 });
    expect(editStats({}, undefined)).toEqual({ additions: 0, deletions: 0 });
  });

  it("adds up the lines of every edit, old/new text and unified diffs alike", () => {
    const items = [
      edit("a", "one\ntwo\n", "one\n2\nthree\n"),
      edit("b", null, null, "--- a/b.ts\n+++ b/b.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n"),
    ];
    expect(sumEdits(items)).toEqual({ additions: 3, deletions: 2 });
  });

  it("keeps its answer while the key stays the same, and recomputes for a new one", () => {
    const key = {};
    const first = [edit("a", "", "x\n")];
    expect(editStats(key, first)).toEqual({ additions: 1, deletions: 0 });
    const more = [...first, edit("b", "", "y\nz\n")];
    expect(editStats(key, more)).toEqual({ additions: 1, deletions: 0 });
    expect(editStats({}, more)).toEqual({ additions: 3, deletions: 0 });
  });
});

describe("editStats while older history is not loaded", () => {
  it("counts nothing, so the total doesn't grow as you scroll up", () => {
    const items = [edit("a", "x\n", "y\nz\n")];
    expect(editStats({}, items, true)).toEqual({ additions: 0, deletions: 0 });
    const key = {};
    const full = editStats(key, items);
    expect(full.additions).toBeGreaterThan(0);
    // The same object each time: safe as a store selector's result.
    expect(editStats(key, items)).toBe(full);
  });
});
