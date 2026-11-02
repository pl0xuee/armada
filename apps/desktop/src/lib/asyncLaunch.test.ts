import { describe, expect, it } from "vitest";
import { isBackgroundLaunch, runningCount, subagentRuns } from "./agents";
import type { TimelineItem } from "./types";

const user: TimelineItem = { id: "u", agentId: "a", seq: 0, ts: 0, kind: "user_message", text: "go" };
const launch = (output: string, subagent: Record<string, unknown> = {}): Extract<TimelineItem, { kind: "tool_call" }> => ({
  id: "t1",
  agentId: "a",
  seq: 1,
  ts: 1,
  kind: "tool_call",
  toolCallId: "toolu_1",
  title: "Agent",
  toolKind: "think",
  status: "completed",
  locations: [],
  diffs: [],
  output,
  command: null,
  subagent: { kind: "godot-engineer", description: "Finish vfx-pass card", ...subagent },
});

describe("a launch the result calls async", () => {
  it("is a background sub-agent even without the request flag", () => {
    const it = launch("Async agent launched successfully. (This tool result is internal metadata)");
    expect(isBackgroundLaunch(it)).toBe(true);
    const runs = subagentRuns([user, it], true);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ state: "running", background: true, kind: "godot-engineer" });
    expect(runningCount(runs)).toBe(1);
  });
  it("is not one when the result says something else, or the call only manages sub-agents", () => {
    expect(isBackgroundLaunch(launch("Done: found 3 callers."))).toBe(false);
    expect(isBackgroundLaunch(launch("Async agent launched", { control: true }))).toBe(false);
  });
});
