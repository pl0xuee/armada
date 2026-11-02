import { describe, expect, it } from "vitest";
import type { TimelineItem } from "@/lib/types";
import { lastAnswer } from "./lastAnswer";

const base = { agentId: "a", ts: 0 };
const msg = (id: string, text: string, seq: number): TimelineItem =>
  ({ ...base, id, seq, kind: "agent_message", text }) as TimelineItem;
const call = (id: string, seq: number, parent?: string): TimelineItem =>
  ({
    ...base,
    id,
    seq,
    kind: "tool_call",
    toolCallId: id,
    parentToolCallId: parent,
    title: "x",
    status: "completed",
    diffs: [],
  }) as unknown as TimelineItem;
const user = (id: string, seq: number): TimelineItem => ({ ...base, id, seq, kind: "user_message", text: "hi" }) as TimelineItem;

describe("lastAnswer", () => {
  it("is empty without any text", () => {
    expect(lastAnswer([user("u", 1), call("c", 2)])).toEqual({ text: null, streaming: false });
  });

  it("takes the newest message, not the earlier narration", () => {
    const r = lastAnswer([msg("m1", "Looking.", 1), call("c", 2), msg("m2", "All done.", 3)]);
    expect(r).toEqual({ text: "All done.", streaming: true });
  });

  it("joins a message the backend cut in two around a sub-agent's call", () => {
    const r = lastAnswer([
      user("u", 1),
      msg("m1", "The root cause is in the", 2),
      call("sub-child", 3, "sub"),
      msg("m2", "retry path, which never resets.", 4),
    ]);
    expect(r.text).toBe("The root cause is in the retry path, which never resets.");
  });

  it("does not reach past a visible tool call or the user's message", () => {
    const r = lastAnswer([msg("m1", "Before.", 1), call("c", 2), msg("m2", "After.", 3)]);
    expect(r.text).toBe("After.");
    expect(lastAnswer([msg("m0", "Old turn.", 1), user("u", 2), msg("m1", "New.", 3)]).text).toBe("New.");
  });

  it("is not streaming once something else follows the text", () => {
    expect(lastAnswer([msg("m1", "Done.", 1), call("c", 2)]).streaming).toBe(false);
  });
});
