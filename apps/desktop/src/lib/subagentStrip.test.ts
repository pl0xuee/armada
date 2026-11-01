import { describe, expect, it } from "vitest";
import { subagentStrip, type SubagentRun } from "./agents";

function run(id: string, over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    itemId: `item-${id}`,
    toolCallId: id,
    kind: "Explore",
    description: `Task ${id}`,
    startedAt: 1000,
    state: "running",
    step: null,
    background: false,
    model: null,
    effort: null,
    calls: 0,
    ...over,
  };
}

describe("subagentStrip", () => {
  it("is empty without runs", () => {
    const s = subagentStrip([]);
    expect(s).toMatchObject({ running: 0, finished: 0, failed: 0, step: null, since: null, focus: null });
  });

  it("names a single running sub-agent by its description", () => {
    const s = subagentStrip([run("a", { description: "Find callers", startedAt: 5000, step: "Read client.ts" })]);
    expect(s.headline).toBe("Find callers");
    expect(s.running).toBe(1);
    expect(s.step).toBe("Read client.ts");
    expect(s.since).toBe(5000);
    expect(s.focus?.toolCallId).toBe("a");
  });

  it("counts several, times from the earliest launch and points at the newest", () => {
    const s = subagentStrip([
      run("a", { startedAt: 4000 }),
      run("b", { startedAt: 2000 }),
      run("c", { startedAt: 9000 }),
    ]);
    expect(s.headline).toBe("3 sub-agents working");
    expect(s.since).toBe(2000);
    expect(s.focus?.toolCallId).toBe("c");
  });

  it("takes the step of the newest running sub-agent that has one", () => {
    const s = subagentStrip([run("a", { step: "Search x" }), run("b", { step: "Fetch y" }), run("c")]);
    expect(s.step).toBe("Fetch y");
  });

  it("ignores finished runs while others still work", () => {
    const s = subagentStrip([run("a", { state: "done", step: "old" }), run("b", { description: "Still going" })]);
    expect(s.headline).toBe("Still going");
    expect(s.running).toBe(1);
    expect(s.finished).toBe(1);
    expect(s.step).toBeNull();
    expect(s.focus?.toolCallId).toBe("b");
  });

  it("summarizes the finished runs once none is running", () => {
    expect(subagentStrip([run("a", { state: "done", description: "Did it" })]).headline).toBe("Did it");
    const two = subagentStrip([run("a", { state: "done" }), run("b", { state: "done" })]);
    expect(two.headline).toBe("2 sub-agents finished");
    expect(two.since).toBeNull();
    expect(two.focus?.toolCallId).toBe("b");
    const bad = subagentStrip([run("a", { state: "done" }), run("b", { state: "failed" })]);
    expect(bad.headline).toBe("2 sub-agents finished, 1 failed");
    expect(bad.failed).toBe(1);
  });
});
