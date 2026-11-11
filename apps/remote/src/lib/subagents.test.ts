import { describe, expect, it } from "vitest";
import { clockExpiry, hasBackgroundSubagent, inheritedConfig, runningSubagents, subagentChips, SUBAGENT_TICK_MS, runningCount, SUBAGENT_ACTIVE_WINDOW_MS, SUBAGENT_LAUNCH_GRACE_MS, subagentRuns } from "./subagents";
import type { TimelineItem, ToolCallItem } from "./types";

let seq = 0;
function call(id: string, ts: number, extra: Partial<ToolCallItem> = {}): ToolCallItem {
  seq++;
  return { id, agentId: "a", seq, ts, kind: "tool_call", toolCallId: `tc-${id}`, title: id, toolKind: "other", status: "completed", locations: [], diffs: [], output: "", command: null, ...extra };
}
const user = (ts: number): TimelineItem => ({ id: `u${ts}`, agentId: "a", seq: ++seq, ts, kind: "user_message", text: "go" });
const NOW = 1_000_000_000;

describe("subagentRuns", () => {
  it("counts an open call only while the agent is busy", () => {
    const items = [user(1), call("s", 2, { subagent: { kind: "Explore" }, status: "in_progress" })];
    expect(runningCount(subagentRuns(items, true))).toBe(1);
    expect(subagentRuns(items, false)).toEqual([]); // stale: leftover open call of an idle agent
  });

  it("never counts Codex control calls", () => {
    const items = [user(1), call("w", 2, { subagent: { kind: "wait", control: true }, status: "in_progress" }), call("s", 3, { subagent: { kind: "worker" }, status: "in_progress" })];
    expect(subagentRuns(items, true).map((r) => r.itemId)).toEqual(["s"]);
    expect(hasBackgroundSubagent([call("w", 2, { subagent: { control: true, background: true } })])).toBe(false);
  });

  it("keeps a background sub-agent running after its launch call completed", () => {
    const items = [user(1), call("bg", 2, { subagent: { kind: "x", background: true } })];
    // Busy and after the last prompt, no clock.
    expect(runningCount(subagentRuns(items, true))).toBe(1);
    // Idle agent: only the clock rules apply. Within the launch grace, still running...
    const early = { now: 2 + SUBAGENT_LAUNCH_GRACE_MS - 1, live: true };
    expect(subagentRuns(items, false, early)[0]).toMatchObject({ state: "running", background: true });
    // ...then done, once nothing happened for a while.
    expect(subagentRuns(items, false, { now: NOW, live: true })[0].state).toBe("done");
    // A recent child call counts as activity.
    const withChild = [...items, call("c", NOW - SUBAGENT_ACTIVE_WINDOW_MS + 1000, { parentToolCallId: "tc-bg" })];
    expect(subagentRuns(withChild, false, { now: NOW, live: true })[0].state).toBe("running");
    // An interrupted agent has none running.
    expect(subagentRuns(withChild, false, { now: NOW, live: false })[0].state).toBe("done");
  });

  it("reports failed sub-agents of the current turn only", () => {
    const items = [user(1), call("old", 2, { subagent: {}, status: "completed" }), user(3), call("bad", 4, { subagent: {}, status: "failed" }), call("ok", 5, { subagent: {} })];
    expect(subagentRuns(items, false).map((r) => [r.itemId, r.state])).toEqual([["bad", "failed"], ["ok", "done"]]);
  });
});

describe("clockExpiry", () => {
  const bg = (ts: number) => call("bg", ts, { subagent: { kind: "x", background: true } });

  it("is 0 without a background launcher", () => {
    expect(clockExpiry(undefined)).toBe(0);
    expect(clockExpiry([user(1), call("s", 2, { subagent: { kind: "Explore" } })])).toBe(0);
    expect(clockExpiry([user(1), bg(2)].map((i) => ({ ...i, status: "in_progress" }) as TimelineItem))).toBe(0);
  });

  it("covers the launch grace, then the last child's active window", () => {
    expect(clockExpiry([user(1), bg(1000)])).toBe(1000 + SUBAGENT_LAUNCH_GRACE_MS);
    const withChild = [user(1), bg(1000), call("c", 500_000, { parentToolCallId: "tc-bg" })];
    expect(clockExpiry(withChild)).toBe(500_000 + SUBAGENT_ACTIVE_WINDOW_MS);
  });

  it("keeps an open child call alive until it goes stale", () => {
    const items = [user(1), bg(1000), call("c", 500_000, { parentToolCallId: "tc-bg", status: "in_progress" })];
    expect(clockExpiry(items)).toBe(500_000 + 30 * 60_000);
  });

  it("agrees with subagentRuns: no tick past the expiry can change a result", () => {
    const items = [user(1), bg(1000), call("c", 500_000, { parentToolCallId: "tc-bg" })];
    const end = clockExpiry(items);
    const before = subagentRuns(items, false, { now: end - SUBAGENT_TICK_MS, live: true });
    const after = subagentRuns(items, false, { now: end, live: true });
    expect(before[0].state).toBe("running");
    expect(after[0].state).toBe("done");
    expect(subagentRuns(items, false, { now: end + 10 * SUBAGENT_TICK_MS, live: true })).toEqual(after);
  });
});

describe("runningSubagents", () => {
  it("lists the running ones with kind, task, launch time and tool calls so far", () => {
    const items = [
      user(1),
      call("a", 5, { subagent: { kind: "Explore", description: "Find the router", model: "haiku", effort: "low" }, status: "in_progress", toolCallId: "ta" }),
      call("c1", 6, { parentToolCallId: "ta" }),
      call("c2", 7, { parentToolCallId: "ta" }),
      call("done", 8, { subagent: { kind: "x" }, toolCallId: "td" }),
      call("b", 9, { subagent: {}, status: "in_progress", title: "Task B" }),
    ];
    const list = runningSubagents(items, subagentRuns(items, true));
    expect(list.map((s) => s.id)).toEqual(["a", "b"]);
    expect(list[0]).toEqual({ id: "a", kind: "Explore", description: "Find the router", model: "haiku", effort: "low", startedAt: 5, toolCalls: 2, step: "c2" });
    expect(list[1]).toMatchObject({ kind: "Sub-agent", description: "Task B", model: null, effort: null, toolCalls: 0 });
  });
  it("counts the calls of sub-agents a sub-agent started", () => {
    const items = [
      user(1),
      call("a", 2, { subagent: { kind: "x" }, status: "in_progress", toolCallId: "ta" }),
      call("n", 3, { subagent: { kind: "y" }, status: "in_progress", toolCallId: "tn", parentToolCallId: "ta" }),
      call("c", 4, { parentToolCallId: "tn" }),
    ];
    expect(runningSubagents(items, subagentRuns(items, true))[0].toolCalls).toBe(2);
  });
  it("is empty when nothing runs", () => {
    expect(runningSubagents([user(1), call("d", 2, { subagent: { kind: "x" } })], subagentRuns([user(1)], true))).toEqual([]);
  });
});

describe("subagent chips", () => {
  const opt = (category: string, currentValue: string, name: string) => ({ id: category, name, category, currentValue, options: [{ value: currentValue, name, description: null }] });
  const agent = { configOptions: [opt("model", "opus", "Opus 4.7"), opt("thought_level", "high", "High")], model: null };
  it("reads the main agent's model and effort", () => {
    expect(inheritedConfig(agent)).toEqual({ model: "Opus 4.7", effort: "High" });
    expect(inheritedConfig({ configOptions: [], model: "qwen" })).toEqual({ model: "qwen", effort: null });
    expect(inheritedConfig({ configOptions: [], model: null })).toEqual({ model: null, effort: null });
  });
  it("shows what the launch named, and inherits the rest", () => {
    const inherited = inheritedConfig(agent);
    expect(subagentChips({ model: "sonnet", effort: "low" }, inherited)).toEqual([
      { key: "model", text: "sonnet", inherited: false },
      { key: "effort", text: "low effort", inherited: false },
    ]);
    expect(subagentChips({ model: "sonnet" }, inherited)).toEqual([
      { key: "model", text: "sonnet", inherited: false },
      { key: "effort", text: "inherits High effort", inherited: true },
    ]);
    expect(subagentChips(undefined, inherited).map((c) => c.text)).toEqual(["inherits Opus 4.7", "inherits High effort"]);
  });
  it("omits what is neither named nor known", () => {
    expect(subagentChips({}, undefined)).toEqual([]);
    expect(subagentChips({ effort: "max" }, { model: null, effort: null })).toEqual([{ key: "effort", text: "max effort", inherited: false }]);
  });
});

describe("sub-agent chips and the helper model", () => {
  const claudeAgent = { provider: "claude", model: "Opus 5.5", configOptions: [] };

  it("shows the helper model for a general-purpose sub-agent when the computer says one is set", () => {
    const inh = inheritedConfig(claudeAgent, "sonnet");
    expect(subagentChips({ kind: "general-purpose" }, inh)).toEqual([{ key: "model", text: "Sonnet, helper setting", inherited: true }]);
    expect(subagentChips({ kind: "Sub-agent" }, inh)[0].text).toBe("Sonnet, helper setting");
  });

  it("shows the helper setting for a launch that names a model, which the computer's hook replaces", () => {
    const inh = inheritedConfig(claudeAgent, "sonnet");
    expect(subagentChips({ kind: "general-purpose", model: "opus" }, inh)[0]).toEqual({ key: "model", text: "Sonnet, helper setting", inherited: true });
    expect(subagentChips({ kind: "general-purpose", model: "opus" }, inheritedConfig(claudeAgent, null))[0].text).toBe("opus");
  });

  it("says nothing it can't know for a sub-agent with its own definition, keeps plans on the main agent", () => {
    const inh = inheritedConfig(claudeAgent, "sonnet");
    expect(subagentChips({ kind: "web-fetch" }, inh)).toEqual([]);
    expect(subagentChips({ kind: "Plan" }, inh)[0].text).toBe("inherits Opus 5.5");
  });

  it("inherits when no helper model is set, and keeps the old chips for an older server or another provider", () => {
    expect(subagentChips({ kind: "general-purpose" }, inheritedConfig(claudeAgent, null))[0].text).toBe("inherits Opus 5.5");
    expect(subagentChips({ kind: "web-fetch" }, inheritedConfig(claudeAgent))[0].text).toBe("inherits Opus 5.5");
    expect(inheritedConfig({ ...claudeAgent, provider: "codex" }, "sonnet").claude).toBeUndefined();
  });
});

describe("helper effort chips", () => {
  const claude = { provider: "claude", configOptions: [], model: "Opus" };
  it("shows the helper effort setting for a general-purpose helper and for a named effort", () => {
    const inherited = inheritedConfig(claude, "sonnet", "low");
    expect(inherited.claude).toEqual({ helper: "Sonnet", helperEffort: "Low" });
    expect(subagentChips({ kind: "general-purpose" }, inherited).map((c) => c.text)).toEqual(["Sonnet, helper setting", "Low, helper setting"]);
    expect(subagentChips({ kind: "Explore", effort: "high" }, inherited).map((c) => c.text)).toEqual(["Low, helper setting"]);
    expect(subagentChips({ kind: "Explore" }, inherited)).toEqual([]);
  });
  it("leaves effort to Claude when no helper effort is set", () => {
    expect(inheritedConfig(claude, "sonnet", null).claude).toEqual({ helper: "Sonnet" });
  });
});

describe("an agent's own helper choice", () => {
  it("wins over the computer's settings, where same and auto mean none", async () => {
    const { agentHelperChoice } = await import("./subagents");
    expect(agentHelperChoice({}, "sonnet", "low")).toEqual({ helperModel: "sonnet", helperEffort: "low" });
    expect(agentHelperChoice({ subagentModel: "haiku" }, "sonnet", "low")).toEqual({ helperModel: "haiku", helperEffort: "low" });
    expect(agentHelperChoice({ subagentModel: "same", subagentEffort: "auto" }, "sonnet", "low")).toEqual({
      helperModel: null,
      helperEffort: null,
    });
    // An older server sent no helper model: nothing is assumed.
    expect(agentHelperChoice({ subagentModel: "haiku" }, undefined, undefined)).toEqual({
      helperModel: undefined,
      helperEffort: undefined,
    });
  });
});
