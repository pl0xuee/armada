import { describe, expect, it } from "vitest";
import { liveTail, needsAttention, runningCount, subagentRuns, triageQueue } from "./agents";
import { seedAgents } from "./mock-data";
import type { Agent, TimelineItem } from "./types";

const base: Agent = { ...seedAgents()[0] };

function agent(patch: Partial<Agent>): Agent {
  return {
    ...base,
    status: "idle",
    archived: false,
    unread: false,
    rateLimited: false,
    pendingPermissions: 0,
    acknowledgedAt: null,
    lastActivityAt: 1_000,
    ...patch,
  };
}

describe("needsAttention", () => {
  it("is null for a quiet idle agent", () => {
    expect(needsAttention(agent({}))).toBeNull();
  });
  it("reports pending permissions, even when acknowledged after the last activity", () => {
    expect(needsAttention(agent({ pendingPermissions: 1, acknowledgedAt: 5_000 }))).toBe("permission");
    expect(needsAttention(agent({ status: "needs_permission" }))).toBe("permission");
  });
  it("hides acknowledged agents until new activity", () => {
    expect(needsAttention(agent({ status: "error", acknowledgedAt: 1_000, lastActivityAt: 1_000 }))).toBeNull();
    expect(needsAttention(agent({ status: "error", acknowledgedAt: 1_000, lastActivityAt: 2_000 }))).toBe("error");
  });
  it("never reports archived agents", () => {
    expect(needsAttention(agent({ archived: true, pendingPermissions: 2 }))).toBeNull();
  });
  it("ranks rate limits, errors and unread finished turns", () => {
    expect(needsAttention(agent({ rateLimited: true, status: "error" }))).toBe("rate_limited");
    expect(needsAttention(agent({ status: "error" }))).toBe("error");
    expect(needsAttention(agent({ unread: true, status: "idle" }))).toBe("done");
    expect(needsAttention(agent({ unread: true, status: "working" }))).toBeNull();
  });
});

describe("triageQueue", () => {
  it("orders by urgency, then oldest activity first", () => {
    const q = triageQueue([
      agent({ id: "done-old", unread: true, lastActivityAt: 10 }),
      agent({ id: "err", status: "error", lastActivityAt: 50 }),
      agent({ id: "perm-new", pendingPermissions: 1, lastActivityAt: 90 }),
      agent({ id: "perm-old", pendingPermissions: 1, lastActivityAt: 20 }),
      agent({ id: "limit", rateLimited: true, lastActivityAt: 70 }),
      agent({ id: "quiet" }),
    ]);
    expect(q.map((x) => x.agent.id)).toEqual(["perm-old", "perm-new", "limit", "err", "done-old"]);
  });
});

describe("liveTail", () => {
  const item = (kind: TimelineItem["kind"], extra: Record<string, unknown>, seq: number): TimelineItem =>
    ({ id: `i${seq}`, agentId: "a", seq, ts: seq, kind, ...extra }) as TimelineItem;
  const tool = (seq: number, status: string, title: string) =>
    item(
      "tool_call",
      { toolCallId: `t${seq}`, title, toolKind: "read", status, locations: [], diffs: [], output: "", command: null },
      seq,
    );

  it("is null without items or right after the user's message", () => {
    expect(liveTail(undefined)).toBeNull();
    expect(liveTail([item("user_message", { text: "hi" }, 1)])).toBeNull();
  });
  it("shows the running tool", () => {
    expect(liveTail([item("user_message", { text: "hi" }, 1), tool(2, "in_progress", "Read a.ts")])).toBe("Read a.ts");
  });
  it("shows a pending approval", () => {
    const perm = item(
      "permission",
      {
        requestId: "r",
        title: "Run npm test",
        toolKind: "execute",
        command: "npm test",
        diffs: [],
        options: [],
        resolution: null,
      },
      3,
    );
    expect(liveTail([item("user_message", { text: "hi" }, 1), perm])).toBe("Waiting for approval: Run npm test");
  });
  it("summarises the latest thought", () => {
    const t = liveTail([item("user_message", { text: "hi" }, 1), item("thought", { text: "**Plan** the  fix" }, 2)]);
    expect(t).toBe("Thinking: Plan the fix");
  });
  it("labels a running sub-agent", () => {
    const sub = item(
      "tool_call",
      {
        toolCallId: "s",
        title: "x",
        toolKind: "other",
        status: "in_progress",
        locations: [],
        diffs: [],
        output: "",
        command: null,
        subagent: { kind: "Explore", description: "find callers" },
      },
      2,
    );
    expect(liveTail([item("user_message", { text: "hi" }, 1), sub])).toBe("Explore: find callers");
  });
});

describe("subagentRuns", () => {
  let n = 0;
  const call = (
    toolCallId: string,
    status: "in_progress" | "completed" | "failed",
    subagent?: { kind?: string; background?: boolean; control?: boolean },
    parentToolCallId?: string,
  ): TimelineItem => ({
    id: `i${++n}`,
    agentId: "a",
    seq: n,
    ts: n,
    kind: "tool_call",
    toolCallId,
    title: toolCallId,
    toolKind: "other",
    status,
    locations: [],
    diffs: [],
    output: "",
    command: null,
    subagent: subagent ? { description: `desc ${toolCallId}`, ...subagent } : undefined,
    parentToolCallId,
  });
  const user: TimelineItem = { id: "u", agentId: "a", seq: 0, ts: 0, kind: "user_message", text: "go" };

  it("counts an open foreground sub-agent only while the agent is busy", () => {
    const items = [user, call("s1", "in_progress", { kind: "Explore" })];
    expect(runningCount(subagentRuns(items, true))).toBe(1);
    expect(subagentRuns(items, false)).toEqual([]);
  });

  it("keeps a completed background sub-agent running until the turn ends", () => {
    const items = [user, call("s1", "completed", { background: true }), call("c1", "in_progress", undefined, "s1")];
    const busy = subagentRuns(items, true);
    expect(busy).toHaveLength(1);
    expect(busy[0]).toMatchObject({ state: "running", step: "c1", background: true });
    expect(subagentRuns(items, false)[0].state).toBe("done");
  });

  it("does not carry a background sub-agent into a later turn", () => {
    const items = [user, call("s1", "completed", { background: true }), { ...user, id: "u2" }];
    expect(runningCount(subagentRuns(items, true))).toBe(0);
    expect(subagentRuns(items, true)).toEqual([]);
  });

  it("lists sub-agents finished this turn and ignores control calls", () => {
    const items = [
      user,
      call("s1", "completed", {}),
      call("s2", "failed", {}),
      call("w", "in_progress", { control: true }),
    ];
    const runs = subagentRuns(items, true);
    expect(runs.map((r) => r.state)).toEqual(["done", "failed"]);
    expect(runningCount(runs)).toBe(0);
  });
});
