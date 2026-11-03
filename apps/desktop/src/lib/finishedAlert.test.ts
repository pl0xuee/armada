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
    // Nothing known: no text, so the backend says what it knows (with the agent's last message).
    expect(workflowFinishedDetail(null, [])).toBeNull();
    expect(workflowFinishedDetail("  ", [], "  ")).toBeNull();
    expect(workflowFinishedDetail(null, [ok, ok])).toBe("Workflow finished. All 2 agents completed.");
    expect(workflowFinishedDetail("x", [ok])).toBe("Workflow finished: “x”. The agent completed.");
    expect(workflowFinishedDetail("x", [ok, { status: "unknown" }])).toBe(
      "Workflow finished: “x”. 1 of 2 agents reported completing.",
    );
  });
  it("shortens a long description to one line", () => {
    const text = workflowFinishedDetail(`${"long ".repeat(60)}\nend`, [ok]) ?? "";
    expect(text).not.toContain("\n");
    expect(text.length).toBeLessThan(160);
  });
  it("quotes what the agent last said when the run has no description", () => {
    expect(workflowFinishedDetail(null, [ok, ok], "Launched two reviewers\non the login flow.")).toBe(
      "Workflow finished. All 2 agents completed. Last message: “Launched two reviewers on the login flow.”",
    );
    expect(workflowFinishedDetail(null, [], "Checking the build.")).toBe(
      "Workflow finished. Last message: “Checking the build.”",
    );
    expect(workflowFinishedDetail(null, [ok, { status: "failed" }], "Fixing tests")).toBe(
      "Workflow finished with problems. 1 of 2 agents completed, 1 failed. Last message: “Fixing tests”",
    );
    // A description says what the run was: the last message is left out.
    expect(workflowFinishedDetail("Review", [ok], "Launched it")).toBe("Workflow finished: “Review”. The agent completed.");
    const long = workflowFinishedDetail(null, [ok], "word ".repeat(100)) ?? "";
    expect(long.length).toBeLessThan(200);
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
