import { describe, expect, it } from "vitest";
import { runningCount, runningSubagents, subagentRuns } from "./subagents";
import { turnStart } from "./thinking";
import type { TimelineItem, ToolCallItem } from "./types";

const T0 = 1_000_000_000;
let seq = 0;
function call(id: string, ts: number, extra: Partial<ToolCallItem> = {}): ToolCallItem {
  seq++;
  return { id, agentId: "a", seq, ts, kind: "tool_call", toolCallId: id, title: id, toolKind: "other", status: "completed", locations: [], diffs: [], output: "", command: null, ...extra };
}
const user: TimelineItem = { id: "u", agentId: "a", seq: 0, ts: T0 - 10, kind: "user_message", text: "go" };
const nudge: TimelineItem = { id: "u2", agentId: "a", seq: 0, ts: T0 + 500, kind: "user_message", text: "also this", midTurn: true };
const launch = call("bg", T0, { subagent: { description: "Review", background: true } });

describe("a message sent into a running turn", () => {
  it("does not start a new turn: the background sub-agent before it still counts", () => {
    expect(runningCount(subagentRuns([user, launch], true))).toBe(1);
    expect(runningCount(subagentRuns([user, launch, nudge], true))).toBe(1);
    // A real new message does end it (without a clock only the turn rule applies).
    expect(runningCount(subagentRuns([user, launch, { ...nudge, midTurn: false }], true))).toBe(0);
  });

  it("keeps the turn's start time", () => {
    expect(turnStart([user, launch, nudge], 0)).toBe(T0 - 10);
  });
});

describe("workflow runs", () => {
  it("are not counted or listed as sub-agents", () => {
    const flow = call("wf", T0, { status: "pending", subagent: { description: "Review changes", workflow: { transcriptDir: "/tmp/x" } } });
    const runs = subagentRuns([user, flow], true);
    expect(runs).toHaveLength(1);
    expect(runningCount(runs)).toBe(0);
    expect(runningSubagents([user, flow], runs)).toEqual([]);
  });
});
