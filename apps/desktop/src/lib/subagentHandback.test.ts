import { describe, expect, it } from "vitest";
import { runningCount, subagentRuns } from "./agents";
import type { TimelineItem } from "./types";

let n = 0;
const base = () => ({ agentId: "a", seq: ++n, ts: n * 1000 });
const user = (): TimelineItem => ({ ...base(), id: `u${n}`, kind: "user_message", text: "go" }) as TimelineItem;
const launch = (toolCallId: string): TimelineItem =>
  ({
    ...base(),
    id: `s${n}`,
    kind: "tool_call",
    toolCallId,
    title: toolCallId,
    toolKind: "other",
    status: "completed",
    locations: [],
    diffs: [],
    output: "Async agent launched successfully.",
    command: null,
    subagent: { description: `desc ${toolCallId}`, background: true },
  }) as unknown as TimelineItem;
const child = (parent: string, title: string, status: "in_progress" | "completed"): TimelineItem =>
  ({
    ...base(),
    id: `c${n}`,
    kind: "tool_call",
    toolCallId: `${parent}-${title}`,
    title,
    toolKind: "other",
    status,
    locations: [],
    diffs: [],
    output: "",
    command: null,
    parentToolCallId: parent,
  }) as unknown as TimelineItem;

describe("a sub-agent that handed back", () => {
  it("is finished, even while the main agent is still busy and its last call looks open", () => {
    const items = [user(), launch("one"), launch("two"), child("one", "SubagentHandback", "in_progress")];
    const runs = subagentRuns(items, true);
    expect(runs.map((r) => [r.toolCallId, r.state])).toEqual([
      ["one", "done"],
      ["two", "running"],
    ]);
    expect(runningCount(runs)).toBe(1);
  });

  it("also counts with a clock (the 'recent activity' rule does not keep it running)", () => {
    const items = [user(), launch("one"), child("one", "SubagentHandback", "completed")];
    const now = items[items.length - 1].ts + 1000;
    expect(runningCount(subagentRuns(items, true, { now, live: true }))).toBe(0);
  });
});
