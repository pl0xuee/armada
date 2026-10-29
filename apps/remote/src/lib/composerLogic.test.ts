import { describe, expect, it } from "vitest";
import { filterCommands, insertCommand, reconcilePending, slashQuery } from "./composerLogic";
import type { PendingPrompt } from "./store";
import type { TimelineItem } from "./types";

const pending = (id: string, text: string, extra: Partial<PendingPrompt> = {}): PendingPrompt => ({
  id,
  text,
  ts: 0,
  failed: false,
  sent: true,
  afterSeq: 5,
  attachments: [],
  key: "k",
  progress: null,
  ...extra,
});
const user = (seq: number, text: string): TimelineItem => ({ id: `u${seq}`, agentId: "a", seq, ts: 0, kind: "user_message", text });

describe("reconcilePending", () => {
  it("drops prompts echoed in the timeline after they were sent", () => {
    const p = [pending("p1", "hello"), pending("p2", "again")];
    expect(reconcilePending(p, [user(6, "hello ")], []).map((x) => x.id)).toEqual(["p2"]);
    // An older identical message doesn't count.
    expect(reconcilePending(p, [user(3, "hello")], [])).toBe(p);
  });
  it("drops prompts that landed in the queue (agent busy)", () => {
    const p = [pending("p1", "later please")];
    expect(reconcilePending(p, [], [{ id: "q", text: "later please", attachments: 0 }])).toEqual([]);
  });
  it("keeps prompts that are still sending or failed", () => {
    const p = [pending("p1", "x", { sent: false }), pending("p2", "y", { failed: true })];
    expect(reconcilePending(p, [user(9, "y")], [{ id: "q", text: "x", attachments: 0 }])).toBe(p);
  });
});

describe("slash commands", () => {
  const cmds = [
    { name: "compact", description: "Summarize the conversation", hint: null },
    { name: "review", description: "Review changes", hint: "[focus]" },
    { name: "cost", description: "Show usage", hint: null },
  ];
  it("detects a command being typed", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/Rev")).toBe("rev");
    expect(slashQuery("/review now")).toBeNull();
    expect(slashQuery("hello /x")).toBeNull();
  });
  it("ranks prefix matches before substring matches", () => {
    expect(filterCommands(cmds, "co").map((c) => c.name)).toEqual(["compact", "cost"]);
    expect(filterCommands(cmds, "usage").map((c) => c.name)).toEqual(["cost"]);
    // Initials, as in Claude Code: "rc" finds remote-control (after name matches).
    const withRc = [...cmds, { name: "remote-control", description: null, hint: null }];
    expect(filterCommands(withRc, "rc").map((c) => c.name)).toEqual(["remote-control"]);
    expect(filterCommands(cmds, "").map((c) => c.name)).toEqual(["compact", "review", "cost"]);
  });
  it("inserts the command with a trailing space", () => {
    expect(insertCommand({ name: "/review", description: null, hint: null })).toBe("/review ");
  });
});

describe("coalesceDeltas", () => {
  it("merges chained deltas for the same field and keeps everything else in order", async () => {
    const { coalesceDeltas } = await import("./composerLogic");
    const d = (itemId: string, offset: number, delta: string) =>
      ({ type: "text_delta", agentId: "a", itemId, field: "text", offset, delta }) as const;
    const out = coalesceDeltas([
      d("m", 0, "Hel"),
      d("m", 3, "lo"),
      d("m", 5, " world"),
      { type: "resync" },
      d("m", 11, "!"),
      d("x", 0, "a"),
      d("x", 5, "gap"), // offsets don't chain: kept separate
    ]);
    expect(out).toEqual([d("m", 0, "Hello world"), { type: "resync" }, d("m", 11, "!"), d("x", 0, "a"), d("x", 5, "gap")]);
  });
});

describe("throttledProgress / ship outcome / commit message", () => {
  it("reports progress at most every interval but always the end", async () => {
    const { throttledProgress, shipOutcome, commitMessage } = await import("./outcomes");
    const seen: number[] = [];
    const p = throttledProgress((f) => seen.push(f), 1_000_000);
    p(0.1);
    p(0.2);
    p(1);
    expect(seen).toEqual([0.1, 1]);
    expect(shipOutcome({ committed: "abc", merged: "Merged x into main", error: null })).toMatchObject({ tone: "ok", title: "Committed and merged" });
    expect(shipOutcome({ committed: "abc", merged: null, error: "Committed abc on x, but the merge failed: conflict" })).toMatchObject({
      tone: "warn",
      title: "Committed, but the merge failed",
    });
    expect(commitMessage({ hash: "abc", message: "Committed 3 files (abc)" })).toBe("Committed 3 files (abc)");
    expect(commitMessage("legacy text")).toBe("legacy text");
  });
});
