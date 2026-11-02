import { describe, expect, it } from "vitest";
import { NotifiedRuns, workflowFinishedDetail } from "./finishedAlert";

function memory(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => void (data[k] = v),
  };
}

describe("workflowFinishedDetail", () => {
  const ok = { status: "finished" as const };
  it("names the run and the outcome", () => {
    expect(workflowFinishedDetail("Five parallel agents build the follow-ups", [ok, ok, ok, ok, ok])).toBe(
      "Workflow finished: “Five parallel agents build the follow-ups”. All 5 agents completed.",
    );
  });
  it("says when something failed", () => {
    expect(workflowFinishedDetail("Review", [ok, ok, { status: "failed" }])).toBe(
      "Workflow finished with problems: “Review”. 2 of 3 agents completed, 1 failed.",
    );
  });
  it("copes with no description, no agents, one agent and an unclear ending", () => {
    expect(workflowFinishedDetail(null, [])).toBe("Workflow finished: its workflow.");
    expect(workflowFinishedDetail("x", [ok])).toBe("Workflow finished: “x”. The agent completed.");
    expect(workflowFinishedDetail("x", [ok, { status: "unknown" }])).toBe(
      "Workflow finished: “x”. 1 of 2 agents reported completing.",
    );
  });
  it("shortens a long description to one line", () => {
    const text = workflowFinishedDetail(`${"long ".repeat(60)}\nend`, [ok]);
    expect(text).not.toContain("\n");
    expect(text.length).toBeLessThan(160);
  });
});

describe("NotifiedRuns", () => {
  it("remembers a run, also after a reload", () => {
    const store = memory();
    const a = new NotifiedRuns(store);
    expect(a.has("a1:t1")).toBe(false);
    a.add("a1:t1");
    expect(a.has("a1:t1")).toBe(true);
    expect(new NotifiedRuns(store).has("a1:t1")).toBe(true);
  });
  it("keeps only the newest few hundred and survives bad stored data", () => {
    const store = memory();
    const a = new NotifiedRuns(store);
    for (let i = 0; i < 350; i++) a.add(`k${i}`);
    expect(a.has("k0")).toBe(false);
    expect(a.has("k349")).toBe(true);
    expect(new NotifiedRuns(memory({ "kvistcode.bgfinished.v1": "{not json" })).has("x")).toBe(false);
    expect(new NotifiedRuns(null).has("x")).toBe(false);
    expect(() => new NotifiedRuns(null).add("x")).not.toThrow();
  });
});
