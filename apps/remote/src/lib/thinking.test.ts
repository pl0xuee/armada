import { describe, expect, it } from "vitest";
import { formatElapsed, THINKING_VERBS, turnStart, waitingLabel, waitingStatus, workingLabel } from "./thinking";
import type { TimelineItem } from "./types";

const it_ = (kind: string, ts: number) => ({ id: `${kind}${ts}`, agentId: "a", seq: ts, ts, kind }) as unknown as TimelineItem;

describe("working indicator wording", () => {
  it("formats elapsed time like the desktop", () => {
    expect(formatElapsed(4_900)).toBe("4s");
    expect(formatElapsed(65_000)).toBe("1m 05s");
    expect(formatElapsed(-5)).toBe("0s");
  });
  it("says what it waits on", () => {
    expect(waitingLabel(1)).toBe("Waiting on 1 sub-agent");
    expect(waitingLabel(3)).toBe("Waiting on 3 sub-agents");
    expect(workingLabel({ starting: false, name: "Claude", subagents: 2, verb: 0, offset: 0 })).toBe("Waiting on 2 sub-agents");
    expect(workingLabel({ starting: true, name: "Claude", subagents: 2, verb: 0, offset: 0 })).toBe("Starting Claude");
    expect(workingLabel({ starting: false, name: "Claude", subagents: 0, verb: 9, offset: 0 })).toBe(THINKING_VERBS[1]);
  });
  it("shows the waiting line while idle too", () => {
    expect(waitingStatus("idle")).toBe(true);
    expect(waitingStatus("working")).toBe(true);
    expect(waitingStatus("interrupted")).toBe(false);
  });
  it("starts the turn at the last prompt, or at the first item after a finished turn", () => {
    expect(turnStart([it_("user_message", 10), it_("tool_call", 20)], 99)).toBe(10);
    expect(turnStart([it_("user_message", 10), it_("turn_summary", 30), it_("agent_message", 50), it_("tool_call", 60)], 99)).toBe(50);
    expect(turnStart([it_("user_message", 10), it_("turn_summary", 30)], 99)).toBe(99);
    expect(turnStart([], 7)).toBe(7);
  });
});
