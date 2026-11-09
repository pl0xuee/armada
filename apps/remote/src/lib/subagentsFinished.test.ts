import { describe, expect, it } from "vitest";
import { hasBackgroundSubagent, runningCount, runningSubagents, stepLabel, subagentRuns } from "./subagents";
import type { TimelineItem, ToolCallItem } from "./types";

const T0 = 1_000_000_000;
let seq = 0;
function call(id: string, ts: number, extra: Partial<ToolCallItem> = {}): ToolCallItem {
  seq++;
  return { id, agentId: "a", seq, ts, kind: "tool_call", toolCallId: id, title: id, toolKind: "other", status: "completed", locations: [], diffs: [], output: "", command: null, ...extra };
}
const user: TimelineItem = { id: "u", agentId: "a", seq: 0, ts: T0 - 10, kind: "user_message", text: "go" };
// A custom agent that always runs in the background only says so in its result.
const launch = call("bg", T0, { subagent: { description: "Fix review findings" }, output: "Async agent launched successfully.\nagentId: acd05b36e1d1a79c3 (internal)" });
const openChild = call("c1", T0 + 1_000, { title: "python3 - <<'EOF'\nimport re\nEOF", status: "pending", parentToolCallId: "bg" });
const stop = (taskId: string) =>
  call("stop", T0 + 2_000, { title: "TaskStop", output: `{"message":"Successfully stopped task: ${taskId}","task_id":"${taskId}"}` });
const clock = { now: T0 + 5_000, live: true };

describe("finished sub-agents on the phone", () => {
  it("treats an 'Async agent launched' result as a background launch", () => {
    expect(hasBackgroundSubagent([launch])).toBe(true);
  });

  it("stops counting a sub-agent the agent stopped with TaskStop, even while busy", () => {
    expect(runningCount(subagentRuns([user, launch, openChild], true, clock))).toBe(1);
    expect(runningCount(subagentRuns([user, launch, openChild, stop("acd05b36e1d1a79c3")], true, clock))).toBe(0);
    expect(runningCount(subagentRuns([user, launch, openChild, stop("other")], true, clock))).toBe(1);
  });

  it("stops counting a sub-agent that handed back its result", () => {
    const handback = call("hb", T0 + 3_000, { title: "SubagentHandback", parentToolCallId: "bg" });
    expect(runningCount(subagentRuns([user, launch, openChild, handback], true, clock))).toBe(0);
  });

  it("shows only the first line of a multi-line step", () => {
    const items = [user, launch, openChild];
    expect(runningSubagents(items, subagentRuns(items, true, clock))[0].step).toBe("python3 - <<'EOF'");
    expect(stepLabel("\n  cargo   test\n--all")).toBe("cargo test");
  });
});
