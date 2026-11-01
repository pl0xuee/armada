import { describe, expect, it } from "vitest";
import {
  backgroundActive,
  backgroundDetail,
  backgroundOf,
  backgroundPill,
  backgroundShort,
  computeBackground,
  needsWatch,
  NO_BACKGROUND,
} from "./background";
import type { WorkflowAgent, WorkflowProgress } from "./types";
import { workflowKey, type WorkflowCall, type WorkflowEntry } from "./workflows";

const wa = (id: string, status: WorkflowAgent["status"]): WorkflowAgent => ({
  id,
  label: id,
  phase: null,
  status,
  toolCalls: 1,
  latest: null,
  idleSecs: 1,
});
const run = (state: WorkflowProgress["state"], statuses: WorkflowAgent["status"][]): WorkflowEntry => ({
  progress: { runId: "wf", state, agents: statuses.map((s, i) => wa(`a${i}`, s)) },
  failed: false,
});
const call = (id: string): WorkflowCall => ({ itemId: `item-${id}`, toolCallId: id, ts: 1 });

describe("computeBackground", () => {
  it("counts a run whose report says running, with its agents", () => {
    const b = computeBackground("a", [call("t")], { [workflowKey("a", "t")]: run("running", ["working", "working", "finished"]) }, 0);
    expect(b).toMatchObject({ workflows: 1, wfWorking: 2, wfTotal: 3, subagents: 0 });
    expect(backgroundActive(b)).toBe(true);
  });

  it("is nothing once every run is finished", () => {
    const e = { [workflowKey("a", "t")]: run("finished", ["finished", "failed"]) };
    expect(computeBackground("a", [call("t")], e, 0)).toBe(NO_BACKGROUND);
  });

  it("does not guess: not read yet, quiet (unknown) or unreadable runs are not claimed", () => {
    expect(computeBackground("a", [call("t")], {}, 0)).toBe(NO_BACKGROUND);
    expect(computeBackground("a", [call("t")], { [workflowKey("a", "t")]: run("unknown", ["unknown"]) }, 0)).toBe(
      NO_BACKGROUND,
    );
    expect(computeBackground("a", [call("t")], { [workflowKey("a", "t")]: { progress: null, failed: true } }, 0)).toBe(
      NO_BACKGROUND,
    );
  });

  it("only looks at this agent's runs, and sums several", () => {
    const e = {
      [workflowKey("a", "t1")]: run("running", ["working"]),
      [workflowKey("a", "t2")]: run("running", ["working", "working"]),
      [workflowKey("b", "t3")]: run("running", ["working"]),
    };
    const b = computeBackground("a", [call("t1"), call("t2"), call("t3")], e, 1);
    expect(b).toMatchObject({ workflows: 2, wfWorking: 3, wfTotal: 3, subagents: 1 });
  });

  it("returns the same object for the same numbers", () => {
    expect(backgroundOf(1, 2, 3, 0)).toBe(backgroundOf(1, 2, 3, 0));
    expect(backgroundOf(0, 0, 0, 0)).toBe(NO_BACKGROUND);
  });
});

describe("needsWatch", () => {
  it("keeps reading runs that may still go and drops finished or unreadable ones", () => {
    expect(needsWatch(undefined)).toBe(true);
    expect(needsWatch(run("running", ["working"]))).toBe(true);
    expect(needsWatch(run("unknown", []))).toBe(true);
    expect(needsWatch(run("finished", ["finished"]))).toBe(false);
    expect(needsWatch({ progress: null, failed: true })).toBe(false);
  });
});

describe("wording", () => {
  it("names the workflow and how many of its agents work", () => {
    const b = backgroundOf(1, 3, 5, 0);
    expect(backgroundShort(b)).toBe("Workflow 3 of 5 running");
    expect(backgroundPill(b)).toBe("Turn finished · Workflow 3 of 5 running");
    expect(backgroundDetail(b)).toBe("Its turn finished. A workflow is still running: 3 of 5 agents working.");
  });

  it("says wrapping up between phases and counts several runs", () => {
    expect(backgroundShort(backgroundOf(1, 0, 5, 0))).toBe("Workflow wrapping up");
    expect(backgroundShort(backgroundOf(1, 0, 0, 0))).toBe("Workflow running");
    expect(backgroundShort(backgroundOf(2, 4, 8, 0))).toBe("2 workflows running");
  });

  it("is soft about background agents, because nothing says when they end", () => {
    expect(backgroundShort(backgroundOf(0, 0, 0, 1))).toBe("1 background agent may be running");
    expect(backgroundShort(backgroundOf(0, 0, 0, 2))).toBe("2 background agents may be running");
    expect(backgroundDetail(backgroundOf(0, 0, 0, 2))).toContain("may still be running");
  });

  it("leads with the workflow when both run, and the detail mentions both", () => {
    const b = backgroundOf(1, 2, 5, 2);
    expect(backgroundShort(b)).toBe("Workflow 2 of 5 running");
    expect(backgroundDetail(b)).toContain("workflow is still running");
    expect(backgroundDetail(b)).toContain("2 background agents");
    expect(backgroundShort(NO_BACKGROUND)).toBe("");
    expect(backgroundDetail(NO_BACKGROUND)).toBe("");
  });
});
