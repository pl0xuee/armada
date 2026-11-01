import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineItem, WorkflowAgent, WorkflowProgress } from "./types";

const progressFor = vi.fn<(agentId: string, toolCallId: string) => Promise<WorkflowProgress>>();
vi.mock("./api", () => ({ api: { workflowProgress: (a: string, t: string) => progressFor(a, t) } }));

const {
  orderAgents,
  parseWorkflowKey,
  recentWorkflowKey,
  resetWorkflows,
  summarizeWorkflow,
  useWorkflows,
  watchWorkflow,
  workflowKey,
  WORKFLOW_POLL_MS,
} = await import("./workflows");

function agent(id: string, status: WorkflowAgent["status"], over: Partial<WorkflowAgent> = {}): WorkflowAgent {
  return { id, label: id, phase: null, status, toolCalls: 3, latest: null, idleSecs: 1, ...over };
}

function prog(state: WorkflowProgress["state"], agents: WorkflowAgent[]): WorkflowProgress {
  return { runId: "wf_1", state, agents };
}

function call(id: string, ts: number, workflow = true): TimelineItem {
  return {
    kind: "tool_call",
    id: `item-${id}`,
    agentId: "a",
    seq: ts,
    ts,
    toolCallId: id,
    title: "Workflow",
    toolKind: "think",
    status: "completed",
    locations: [],
    diffs: [],
    output: "",
    command: null,
    subagent: workflow ? { kind: "workflow", workflow: { transcriptDir: "/x/wf_1" } } : undefined,
  } as TimelineItem;
}

describe("summarizeWorkflow", () => {
  it("counts the agents that work and names the run", () => {
    const s = summarizeWorkflow(
      prog("running", [
        agent("a", "working", { latest: "Editing a.ts", idleSecs: 9 }),
        agent("b", "working", { latest: "Running cargo test", idleSecs: 2 }),
        agent("c", "finished"),
      ]),
    );
    expect(s).toMatchObject({ total: 3, working: 2, finished: 1, failed: 0, calls: 9, active: true });
    expect(s.headline).toBe("Workflow · 2 agents working");
    expect(s.step).toBe("Running cargo test");
  });

  it("says 1 agent for one", () => {
    expect(summarizeWorkflow(prog("running", [agent("a", "working")])).headline).toBe("Workflow · 1 agent working");
  });

  it("settles into 'Workflow finished', noting failures", () => {
    expect(summarizeWorkflow(prog("finished", [agent("a", "finished"), agent("b", "finished")])).headline).toBe(
      "Workflow finished",
    );
    const f = summarizeWorkflow(prog("finished", [agent("a", "finished"), agent("b", "failed")]));
    expect(f.headline).toBe("Workflow finished · 1 of 2 failed");
    expect(f).toMatchObject({ active: false, finished: 2, failed: 1 });
  });

  it("covers a run that is starting or between phases", () => {
    expect(summarizeWorkflow(prog("running", [])).headline).toBe("Workflow · starting");
    expect(summarizeWorkflow(prog("running", [agent("a", "finished")])).headline).toBe("Workflow · wrapping up");
    expect(summarizeWorkflow(null)).toMatchObject({ total: 0, active: false, headline: "Workflow" });
  });
});

describe("sub-agent bookkeeping", () => {
  it("leaves workflow runs out of the plain sub-agent runs (they have their own progress)", async () => {
    const { subagentRuns } = await import("./agents");
    const now = Date.now();
    expect(subagentRuns([call("t", now)], true, { now, live: true })).toEqual([]);
  });
});

describe("orderAgents", () => {
  it("puts working agents first and keeps launch order otherwise", () => {
    const out = orderAgents([
      agent("a", "finished"),
      agent("b", "working"),
      agent("c", "unknown"),
      agent("d", "working"),
    ]);
    expect(out.map((a) => a.id)).toEqual(["b", "d", "c", "a"]);
  });
});

describe("recentWorkflowKey", () => {
  const now = 10_000_000_000;
  it("lists the newest workflow calls only, and only recent ones", () => {
    const items = [
      call("old", now - 20 * 3600_000),
      call("t1", now - 3000),
      call("plain", now - 2000, false),
      call("t2", now - 1000),
    ];
    const calls = parseWorkflowKey(recentWorkflowKey(items, now));
    expect(calls.map((c) => c.toolCallId)).toEqual(["t2", "t1"]);
    expect(calls[0]).toMatchObject({ itemId: "item-t2", ts: now - 1000 });
  });
  it("is empty without workflows", () => {
    expect(recentWorkflowKey([call("p", now, false)], now)).toBe("");
    expect(parseWorkflowKey("")).toEqual([]);
  });
});

describe("watchWorkflow polling", () => {
  let blurred = false;
  beforeEach(() => {
    vi.useFakeTimers();
    blurred = false;
    const root = { dataset: {} as Record<string, string> };
    vi.stubGlobal("document", {
      documentElement: root,
      get hidden() {
        return false;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    Object.defineProperty(root.dataset, "window", { get: () => (blurred ? "blurred" : undefined), configurable: true });
    progressFor.mockReset();
    resetWorkflows();
  });
  afterEach(() => {
    resetWorkflows();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const entry = () => useWorkflows.getState().byKey[workflowKey("a", "t")];

  it("polls at once, then every few seconds, and stops when the run finished", async () => {
    progressFor.mockResolvedValue(prog("running", [agent("x", "working")]));
    const leave = watchWorkflow("a", "t");
    await vi.advanceTimersByTimeAsync(0);
    expect(progressFor).toHaveBeenCalledTimes(1);
    expect(entry().progress?.state).toBe("running");
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_MS);
    expect(progressFor).toHaveBeenCalledTimes(2);

    progressFor.mockResolvedValue(prog("finished", [agent("x", "finished")]));
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_MS);
    expect(entry().progress?.state).toBe("finished");
    const calls = progressFor.mock.calls.length;
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_MS * 5);
    expect(progressFor).toHaveBeenCalledTimes(calls);
    leave();
  });

  it("does not ask while the window is blurred", async () => {
    progressFor.mockResolvedValue(prog("running", [agent("x", "working")]));
    blurred = true;
    const leave = watchWorkflow("a", "t");
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_MS * 4);
    expect(progressFor).not.toHaveBeenCalled();
    blurred = false;
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_MS);
    expect(progressFor).toHaveBeenCalledTimes(1);
    leave();
  });

  it("shares one poll between watchers and stops when the last one leaves", async () => {
    progressFor.mockResolvedValue(prog("running", [agent("x", "working")]));
    const l1 = watchWorkflow("a", "t");
    const l2 = watchWorkflow("a", "t");
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_MS);
    expect(progressFor).toHaveBeenCalledTimes(2); // the first poll + one tick, not doubled
    l1();
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_MS);
    expect(progressFor).toHaveBeenCalledTimes(3);
    l2();
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_MS * 3);
    expect(progressFor).toHaveBeenCalledTimes(3);
  });

  it("gives up after repeated failures", async () => {
    progressFor.mockRejectedValue(new Error("nope"));
    const leave = watchWorkflow("a", "t");
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_MS * 6);
    expect(progressFor).toHaveBeenCalledTimes(3);
    expect(entry().failed).toBe(true);
    leave();
  });

  it("does not ask again for a run already known to be finished", async () => {
    useWorkflows.setState({
      byKey: { [workflowKey("a", "t")]: { progress: prog("finished", [agent("x", "finished")]), failed: false } },
    });
    const leave = watchWorkflow("a", "t");
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_MS * 2);
    expect(progressFor).not.toHaveBeenCalled();
    leave();
  });
});
