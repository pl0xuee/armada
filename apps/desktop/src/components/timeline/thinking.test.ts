import { describe, expect, it } from "vitest";
import type { TimelineItem } from "@/lib/types";
import { formatElapsed, shouldShowThinking, turnStart } from "./thinking";

const b = { id: "x", agentId: "a", seq: 0, ts: 100 };
const user = { ...b, kind: "user_message", text: "hi" } as TimelineItem;
const msg = { ...b, kind: "agent_message", text: "" } as TimelineItem;
const thought = { ...b, kind: "thought", text: "" } as TimelineItem;
const tool = (status: string) => ({ ...b, kind: "tool_call", status }) as unknown as TimelineItem;
const perm = (resolution: string | null) => ({ ...b, kind: "permission", resolution }) as unknown as TimelineItem;
const notice = { ...b, kind: "notice" } as unknown as TimelineItem;
const plan = { ...b, kind: "plan" } as unknown as TimelineItem;

describe("shouldShowThinking", () => {
  it("is hidden unless the agent is working or starting", () => {
    for (const s of ["idle", "needs_permission", "error", "interrupted"] as const) {
      expect(shouldShowThinking(s, user)).toBe(false);
    }
  });
  it("shows for an empty timeline and after quiet items", () => {
    expect(shouldShowThinking("starting", undefined)).toBe(true);
    for (const it of [user, tool("completed"), tool("failed"), perm("allow"), plan, notice]) {
      expect(shouldShowThinking("working", it)).toBe(true);
    }
  });
  it("hides while something is visibly streaming", () => {
    for (const it of [msg, thought, tool("in_progress"), tool("pending"), perm(null)]) {
      expect(shouldShowThinking("working", it)).toBe(false);
    }
    expect(shouldShowThinking("working", tool("completed"), true)).toBe(false);
  });
  it("shows once the last agent message has gone quiet mid-turn", () => {
    expect(shouldShowThinking("working", msg, false, true)).toBe(true);
    expect(shouldShowThinking("idle", msg, false, true)).toBe(false);
  });
});

describe("turnStart / formatElapsed", () => {
  it("uses the latest user message", () => {
    expect(turnStart([{ ...user, ts: 5 } as TimelineItem, msg, { ...user, ts: 9 } as TimelineItem], 1)).toBe(9);
    expect(turnStart([msg], 1)).toBe(1);
  });
  it("formats", () => {
    expect(formatElapsed(12_400)).toBe("12s");
    expect(formatElapsed(125_000)).toBe("2m 05s");
    expect(formatElapsed(-5)).toBe("0s");
  });
});
