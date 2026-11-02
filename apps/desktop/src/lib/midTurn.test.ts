import { describe, expect, it } from "vitest";
import { turnEndOf, turnStart } from "@/components/timeline/thinking";
import { liveTail, runningCount, startsTurn, subagentRuns } from "./agents";
import type { TimelineItem } from "./types";

// A message sent with "Send now" while the agent works (`midTurn`) is part of the turn already going.
let n = 0;
const base = () => ({ agentId: "a", seq: ++n, ts: n * 1000 });
const user = (text: string, midTurn = false): TimelineItem => ({ ...base(), id: `u${n}`, kind: "user_message", text, midTurn });
const sub = (toolCallId: string, status: "in_progress" | "completed", background = false): TimelineItem =>
  ({
    ...base(),
    id: `s${n}`,
    kind: "tool_call",
    toolCallId,
    title: toolCallId,
    toolKind: "other",
    status,
    locations: [],
    diffs: [],
    output: "",
    command: null,
    subagent: { description: `desc ${toolCallId}`, background },
  }) as unknown as TimelineItem;
const tool = (title: string, status: "in_progress" | "completed"): TimelineItem =>
  ({
    ...base(),
    id: `t${n}`,
    kind: "tool_call",
    toolCallId: title,
    title,
    toolKind: "execute",
    status,
    locations: [],
    diffs: [],
    output: "",
    command: null,
  }) as unknown as TimelineItem;

describe("a message sent into a running turn", () => {
  it("does not start a turn", () => {
    expect(startsTurn(user("fix it"))).toBe(true);
    expect(startsTurn(user("and the docs", true))).toBe(false);
  });

  it("keeps sub-agents launched earlier in the turn counted (running and finished)", () => {
    const items = [user("go"), sub("run", "in_progress"), sub("done", "completed"), user("also the docs", true)];
    const runs = subagentRuns(items, true);
    expect(runs.map((r) => [r.toolCallId, r.state])).toEqual([
      ["run", "running"],
      ["done", "done"],
    ]);
    expect(runningCount(runs)).toBe(1);
  });

  it("keeps a background sub-agent running (no clock needed) after a mid-turn message", () => {
    const items = [user("go"), sub("bg", "completed", true), user("also the docs", true)];
    expect(runningCount(subagentRuns(items, true))).toBe(1);
  });

  it("still ends the previous turn at a real message", () => {
    const items = [user("go"), sub("old", "completed"), user("next")];
    expect(subagentRuns(items, true)).toEqual([]);
  });

  it("counts the turn's elapsed time from the real prompt, not from the mid-turn message", () => {
    const items = [user("go"), tool("npm test", "in_progress"), user("also the docs", true)];
    expect(turnStart(items, 0)).toBe(items[0].ts);
  });

  it("still names what the agent is doing right now", () => {
    const items = [user("go"), tool("npm test", "in_progress"), user("also the docs", true)];
    expect(liveTail(items)).toBe("npm test");
  });

  it("reports the whole turn's length when it ends", () => {
    const items = [user("go"), tool("npm test", "completed"), user("also the docs", true), tool("rg docs", "completed")];
    const end = turnEndOf("idle", items, items[items.length - 1], 0);
    expect(end?.elapsedMs).toBe(items[items.length - 1].ts - items[0].ts);
  });
});
