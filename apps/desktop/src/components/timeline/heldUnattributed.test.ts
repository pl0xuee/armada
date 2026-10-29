import { describe, expect, it } from "vitest";
import type { TimelineItem } from "@/lib/types";
import { ATTRIBUTION_GRACE_MS, heldUnattributed } from "./Timeline";

const call = (id: string, ts: number, extra: object = {}) =>
  ({ id, agentId: "a", seq: 0, ts, kind: "tool_call", toolCallId: id, status: "in_progress", ...extra }) as unknown as TimelineItem;

describe("heldUnattributed", () => {
  const now = 100_000;
  it("holds only new, unattributed, non-sub-agent calls while waiting on sub-agents", () => {
    const items = [
      call("fresh", now - 1000),
      call("old", now - ATTRIBUTION_GRACE_MS - 1),
      call("child", now - 500, { parentToolCallId: "task1" }),
      call("task", now - 500, { subagent: true }),
    ];
    expect(heldUnattributed(items, true, now)).toEqual(["fresh"]);
  });
  it("holds nothing when not waiting on sub-agents", () => {
    expect(heldUnattributed([call("fresh", now - 10)], false, now)).toEqual([]);
  });
  it("does not hold calls stamped far in the future (clock skew)", () => {
    expect(heldUnattributed([call("skewed", now + 3_600_000)], true, now)).toEqual([]);
  });
});
