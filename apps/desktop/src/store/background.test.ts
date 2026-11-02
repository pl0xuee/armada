import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedAgents } from "@/lib/mock-data";
import type { Agent, TimelineItem, WorkflowAgent, WorkflowProgress } from "@/lib/types";

const progressFor = vi.fn<(agentId: string, toolCallId: string) => Promise<WorkflowProgress>>();
const finishedAlert = vi.fn<(agentId: string, agents: number | null, detail: string | null) => Promise<void>>(() =>
  Promise.resolve(),
);
vi.mock("@/lib/api", () => ({
  api: {
    workflowProgress: (a: string, t: string) => progressFor(a, t),
    backgroundFinished: (a: string, n: number | null, d: string | null) => finishedAlert(a, n, d),
  },
}));

const { forgetAgentDerived } = await import("@/components/agent/derived");
const { hasBackgroundWork, NO_BACKGROUND } = await import("@/lib/background");
const { resetWorkflows, WORKFLOW_POLL_MS } = await import("@/lib/workflows");
const { ALERT_SETTLE_MS } = await import("@/lib/finishedAlert");
const { SUBAGENT_ACTIVE_WINDOW_MS, SUBAGENT_LAUNCH_GRACE_MS, SUBAGENT_TICK_MS } = await import("@/lib/agents");
const { useApp } = await import("./app");
const { useUi } = await import("./ui");
const { installBackgroundTracker, statusView, useBackgroundStore } = await import("./background");

const ID = "a-bg";
const base: Agent = { ...seedAgents()[0], id: ID, status: "idle", unread: true, archived: false };

function wa(id: string, status: WorkflowAgent["status"]): WorkflowAgent {
  return { id, label: id, phase: null, status, toolCalls: 2, latest: null, idleSecs: 1 };
}
const prog = (state: WorkflowProgress["state"], statuses: WorkflowAgent["status"][]): WorkflowProgress => ({
  runId: "wf_1",
  state,
  agents: statuses.map((s, i) => wa(`w${i}`, s)),
});

let seq = 0;
const item = (over: Record<string, unknown>): TimelineItem =>
  ({ id: `i${++seq}`, agentId: ID, seq, ts: Date.now(), ...over }) as TimelineItem;
const user = () => item({ kind: "user_message", text: "go" });
const message = () => item({ kind: "agent_message", text: "All launched." });
const tool = (toolCallId: string, subagent: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  item({
    kind: "tool_call",
    toolCallId,
    title: "Launch",
    toolKind: "think",
    status: "completed",
    locations: [],
    diffs: [],
    output: "",
    command: null,
    subagent,
    ...over,
  });
const workflowCall = (id = "wf") => tool(id, { kind: "workflow", background: true, workflow: { transcriptDir: "/x/wf_1" } });

function setAgent(status: Agent["status"], items: TimelineItem[]) {
  useApp.setState({ agents: { [ID]: { ...base, status } }, items: { [ID]: items } });
}
const bg = () => useBackgroundStore.getState().byAgent[ID] ?? NO_BACKGROUND;
const settle = () => vi.advanceTimersByTimeAsync(0);

let off: (() => void) | null = null;
let blurred = false;

beforeEach(() => {
  vi.useFakeTimers();
  blurred = false;
  const root = { dataset: {} as Record<string, string> };
  Object.defineProperty(root.dataset, "window", { get: () => (blurred ? "blurred" : undefined), configurable: true });
  vi.stubGlobal("document", {
    documentElement: root,
    get hidden() {
      return false;
    },
    hasFocus: () => true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  progressFor.mockReset();
  finishedAlert.mockClear();
  resetWorkflows();
  forgetAgentDerived(ID);
  useApp.setState({ agents: {}, items: {} });
  useUi.setState({ view: "agents", selectedAgentId: null, windowFocused: true });
});

afterEach(() => {
  off?.();
  off = null;
  resetWorkflows();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("background tracker: workflows", () => {
  it("turn ended + workflow running => working in the background; finished => nothing left, and says so", async () => {
    progressFor.mockResolvedValue(prog("running", ["working", "working", "working", "finished", "finished"]));
    setAgent("idle", [user(), workflowCall(), message()]);
    off = installBackgroundTracker();
    await settle();

    expect(bg()).toMatchObject({ workflows: 1, wfWorking: 3, wfTotal: 5, subagents: 0 });
    expect(useBackgroundStore.getState().active.has(ID)).toBe(true);
    expect(hasBackgroundWork(ID)).toBe(true);
    const view = statusView(useApp.getState().agents[ID], false, bg());
    expect(view).toMatchObject({ done: false, background: true, dot: "working" });
    expect(view.meta.label).toBe("Workflow 3 of 5 running");
    expect(view.pill).toBe("Turn finished · Workflow 3 of 5 running");

    progressFor.mockResolvedValue(prog("finished", ["finished", "finished", "finished", "finished", "failed"]));
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_MS);
    expect(bg()).toBe(NO_BACKGROUND);
    expect(useBackgroundStore.getState().active.has(ID)).toBe(false);
    expect(hasBackgroundWork(ID)).toBe(false);
    expect(useBackgroundStore.getState().finishedAt[ID]).toBeGreaterThan(0);
    // Not announced at once: a run must stay finished for a minute, and is then announced with what it was.
    expect(finishedAlert).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ALERT_SETTLE_MS);
    expect(finishedAlert).toHaveBeenCalledTimes(1);
    expect(finishedAlert).toHaveBeenCalledWith(ID, 5, expect.stringContaining("Workflow finished with problems"));
    // ... and never twice for the same run, however often its state is re-read.
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_MS * 3 + ALERT_SETTLE_MS);
    expect(finishedAlert).toHaveBeenCalledTimes(1);
    expect(statusView(useApp.getState().agents[ID], false, bg())).toMatchObject({ done: true, background: false });
  });

  it("does not alert for a run that starts moving again before it settles", async () => {
    progressFor.mockResolvedValue(prog("running", ["working"]));
    setAgent("idle", [user(), workflowCall(), message()]);
    off = installBackgroundTracker();
    await settle();
    progressFor.mockResolvedValue(prog("finished", ["finished"]));
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_MS);
    // A long quiet spell mid-run looked like the end; then it moves again.
    await vi.advanceTimersByTimeAsync(ALERT_SETTLE_MS / 2);
    progressFor.mockResolvedValue(prog("running", ["working"]));
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_MS);
    await vi.advanceTimersByTimeAsync(ALERT_SETTLE_MS);
    expect(finishedAlert).not.toHaveBeenCalled();
  });

  it("does not announce a run that was already finished when the app looked at it", async () => {
    progressFor.mockResolvedValue(prog("finished", ["finished", "finished"]));
    setAgent("idle", [user(), workflowCall(), message()]);
    off = installBackgroundTracker();
    await settle();
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_MS + ALERT_SETTLE_MS * 2);
    expect(finishedAlert).not.toHaveBeenCalled();
  });

  it("does not alert when the user is looking at that agent", async () => {
    useUi.setState({ view: "agents", selectedAgentId: ID, windowFocused: true });
    progressFor.mockResolvedValue(prog("running", ["working"]));
    setAgent("idle", [user(), workflowCall(), message()]);
    off = installBackgroundTracker();
    await settle();
    progressFor.mockResolvedValue(prog("finished", ["finished"]));
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_MS);
    expect(bg()).toBe(NO_BACKGROUND);
    expect(useBackgroundStore.getState().finishedAt[ID]).toBeGreaterThan(0);
    expect(finishedAlert).not.toHaveBeenCalled();
  });

  it("says nothing about a workflow it cannot read, or one that has gone quiet", async () => {
    progressFor.mockRejectedValue(new Error("not allowed"));
    setAgent("idle", [user(), workflowCall(), message()]);
    off = installBackgroundTracker();
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_MS * 4);
    expect(bg()).toBe(NO_BACKGROUND);

    off();
    resetWorkflows();
    forgetAgentDerived(ID);
    progressFor.mockReset();
    progressFor.mockResolvedValue(prog("unknown", ["unknown"]));
    off = installBackgroundTracker();
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_MS * 2);
    expect(bg()).toBe(NO_BACKGROUND);
    expect(finishedAlert).not.toHaveBeenCalled();
  });

  it("does not poll agents without a workflow, and stops asking once it finished", async () => {
    setAgent("idle", [user(), message()]);
    off = installBackgroundTracker();
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_MS * 3);
    expect(progressFor).not.toHaveBeenCalled();

    progressFor.mockResolvedValue(prog("finished", ["finished"]));
    setAgent("idle", [user(), workflowCall("w2"), message()]);
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_MS * 4);
    const calls = progressFor.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_MS * 6);
    expect(progressFor).toHaveBeenCalledTimes(calls);
    expect(bg()).toBe(NO_BACKGROUND);
    // It was never seen running: no "everything finished" claim.
    expect(finishedAlert).not.toHaveBeenCalled();
  });

  it("is not for agents that were stopped or errored (their runs died with them)", async () => {
    progressFor.mockResolvedValue(prog("running", ["working"]));
    setAgent("stopped", [user(), workflowCall(), message()]);
    off = installBackgroundTracker();
    await settle();
    expect(bg()).toBe(NO_BACKGROUND);
    expect(progressFor).not.toHaveBeenCalled();
  });

  it("a new turn clears the finished note", async () => {
    progressFor.mockResolvedValue(prog("running", ["working"]));
    setAgent("idle", [user(), workflowCall(), message()]);
    off = installBackgroundTracker();
    await settle();
    progressFor.mockResolvedValue(prog("finished", ["finished"]));
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_MS);
    expect(useBackgroundStore.getState().finishedAt[ID]).toBeGreaterThan(0);
    useApp.setState({ agents: { [ID]: { ...base, status: "working" } } });
    await settle();
    expect(useBackgroundStore.getState().finishedAt[ID]).toBeUndefined();
  });
});

describe("background tracker: background sub-agents", () => {
  const launch = () => tool("bg1", { kind: "Explore", description: "Survey", background: true }, { ts: Date.now() });
  const child = (ts: number) =>
    tool("c1", {}, { subagent: undefined, parentToolCallId: "bg1", status: "completed", ts, title: "Search" });

  it("counts one that shows signs of life after the turn ended, softly, and lets it lapse without a finished claim", async () => {
    setAgent("idle", [user(), launch(), message()]);
    off = installBackgroundTracker();
    await settle();
    // Just launched: counted, but only as "may be running".
    expect(bg()).toMatchObject({ workflows: 0, subagents: 1 });
    const view = statusView(useApp.getState().agents[ID], true, bg());
    expect(view.meta.label).toBe("1 background agent may be running");
    expect(view.background).toBe(true);

    // Nothing more is heard from it: it lapses by the clock (nothing tells it ended).
    await vi.advanceTimersByTimeAsync(SUBAGENT_LAUNCH_GRACE_MS + SUBAGENT_ACTIVE_WINDOW_MS + SUBAGENT_TICK_MS * 2);
    expect(bg()).toBe(NO_BACKGROUND);
    expect(finishedAlert).not.toHaveBeenCalled();
    expect(useBackgroundStore.getState().finishedAt[ID]).toBeUndefined();
    expect(statusView(useApp.getState().agents[ID], true, bg()).done).toBe(true);
  });

  it("stays counted while its child calls keep arriving", async () => {
    setAgent("idle", [user(), launch(), child(Date.now()), message()]);
    off = installBackgroundTracker();
    await settle();
    expect(bg().subagents).toBe(1);
    await vi.advanceTimersByTimeAsync(SUBAGENT_LAUNCH_GRACE_MS + 10_000);
    setAgent("idle", [user(), launch(), child(Date.now()), message()]);
    await settle();
    expect(bg().subagents).toBe(1);
  });
});

describe("statusView", () => {
  it("only reinterprets an idle agent: working stays working, an errored agent stays an error", () => {
    const b = { workflows: 1, wfWorking: 1, wfTotal: 2, subagents: 0 };
    expect(statusView({ ...base, status: "working" }, false, b)).toMatchObject({ background: false, dot: "working" });
    expect(statusView({ ...base, status: "error" }, false, b)).toMatchObject({ background: false, dot: "error" });
    expect(statusView({ ...base, status: "idle" }, false, b)).toMatchObject({ background: true, done: false });
  });

  it("says Done only when nothing is left running", () => {
    expect(statusView({ ...base, status: "idle", unread: true }, false, NO_BACKGROUND)).toMatchObject({
      done: true,
      pill: "Done",
    });
    expect(statusView({ ...base, status: "idle", unread: false }, false, NO_BACKGROUND)).toMatchObject({
      done: false,
      pill: "Idle",
    });
  });
});
