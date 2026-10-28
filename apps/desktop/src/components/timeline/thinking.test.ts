import { describe, expect, it } from "vitest";
import type { TimelineItem } from "@/lib/types";
import { formatElapsed, shouldShowThinking, turnEndOf, turnStart, waitingStatus } from "./thinking";

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

describe("turnEndOf", () => {
  const u = { ...b, kind: "user_message", text: "hi", ts: 1000 } as TimelineItem;
  const m = { ...b, kind: "agent_message", text: "ok", ts: 2000 } as TimelineItem;
  const summary = { ...b, kind: "turn_summary" } as unknown as TimelineItem;
  const cancelled = { ...b, kind: "notice", level: "info", text: "Turn cancelled" } as unknown as TimelineItem;

  it("is null while busy or without a prompt", () => {
    expect(turnEndOf("working", [u, m], m, 5000)).toBeNull();
    expect(turnEndOf("idle", [m], m, 5000)).toBeNull();
    expect(turnEndOf("interrupted", [u, m], m, 5000)).toBeNull();
  });
  it("reports Done with the turn's duration, also for answer-only turns", () => {
    expect(turnEndOf("idle", [u, m], m)).toEqual({ tone: "done", label: "Done", elapsedMs: 1000 });
  });
  it("leaves the summary card to say it", () => {
    expect(turnEndOf("idle", [u, m, summary], summary, 5000)).toBeNull();
  });
  it("distinguishes errors and user cancels", () => {
    expect(turnEndOf("error", [u, m], m, 5000)?.label).toBe("Stopped with an error");
    const errNotice = { ...b, kind: "notice", level: "error", text: "boom", ts: 3000 } as unknown as TimelineItem;
    expect(turnEndOf("error", [u, m, errNotice], errNotice)).toBeNull();
    expect(turnEndOf("idle", [u, m, cancelled], cancelled, 5000)).toMatchObject({ tone: "stopped", label: "Stopped" });
  });
  it("ignores an unknown or negative duration", () => {
    const early = { ...m, ts: 500 } as TimelineItem;
    expect(turnEndOf("idle", [u, early], early)?.elapsedMs).toBeNull();
  });
});

describe("waitingStatus", () => {
  it("shows the waiting line while working or idle, hides it when blocked or ended", () => {
    for (const s of ["working", "starting", "idle"] as const) expect(waitingStatus(s)).toBe(true);
    for (const s of ["needs_permission", "stopped", "error", "interrupted"] as const)
      expect(waitingStatus(s)).toBe(false);
  });
});
