import { describe, expect, it } from "vitest";
import type { TimelineItem } from "@/lib/types";
import {
  formatElapsed,
  inheritedOf,
  liveStep,
  shouldShowThinking,
  stepText,
  subagentChips,
  turnEndOf,
  turnStart,
  waitingStatus,
} from "./thinking";

const b = { id: "x", agentId: "a", seq: 0, ts: 100 };
const user = { ...b, kind: "user_message", text: "hi" } as TimelineItem;
const msg = { ...b, kind: "agent_message", text: "" } as TimelineItem;
const thought = { ...b, kind: "thought", text: "" } as TimelineItem;
const tool = (status: string) => ({ ...b, kind: "tool_call", status }) as unknown as TimelineItem;
const perm = (resolution: string | null) => ({ ...b, kind: "permission", resolution }) as unknown as TimelineItem;
const notice = { ...b, kind: "notice" } as unknown as TimelineItem;
const plan = { ...b, kind: "plan" } as unknown as TimelineItem;

describe("shouldShowThinking", () => {
  it("is hidden unless the agent is working or starting", () => {
    for (const s of ["idle", "needs_permission", "error", "interrupted"] as const) {
      expect(shouldShowThinking(s, user)).toBe(false);
    }
  });
  it("shows for an empty timeline and under any live item", () => {
    expect(shouldShowThinking("starting", undefined)).toBe(true);
    for (const it of [user, msg, thought, tool("in_progress"), tool("pending"), tool("completed"), plan, notice]) {
      expect(shouldShowThinking("working", it)).toBe(true);
    }
  });
  it("leaves a pending approval to its card", () => {
    expect(shouldShowThinking("working", perm(null))).toBe(false);
    expect(shouldShowThinking("working", perm("allow"))).toBe(true);
  });
});

describe("liveStep", () => {
  const call = (toolKind: string, title: string, extra: Record<string, unknown> = {}) =>
    ({
      ...b,
      id: `${toolKind}-${title}`,
      kind: "tool_call",
      toolCallId: title,
      toolKind,
      title,
      status: "in_progress",
      locations: [],
      command: null,
      ...extra,
    }) as unknown as TimelineItem;
  const text = (items: TimelineItem[], settled = false) => {
    const s = liveStep(items, settled);
    return s && stepText(s);
  };

  it("names a running command, in mono", () => {
    const s = liveStep([user, call("execute", "Run npm test", { command: "npm test" })]);
    expect(s).toEqual({ lead: "Running", detail: "npm test", mono: true });
    expect(text([call("execute", "Run `pnpm build`")])).toBe("Running pnpm build");
  });
  it("describes file tools and counts parallel ones", () => {
    expect(text([call("read", "Read src/foo.ts", { locations: ["src/foo.ts"] })])).toBe("Reading src/foo.ts");
    expect(text([call("edit", "Edit src/a.ts")])).toBe("Editing src/a.ts");
    expect(text([call("edit", "Edit a.ts"), call("edit", "Edit b.ts")])).toBe("Editing 2 files");
    expect(text([call("search", "Search for `foo`")])).toBe('Searching for "foo"');
    expect(text([call("read", "Read a"), call("read", "Read b"), call("read", "Read c")])).toBe("Reading 3 files");
  });
  it("uses the newest unfinished call, ignoring finished and nested ones", () => {
    const done = call("read", "Read old.ts", { status: "completed" });
    expect(text([call("edit", "Edit a.ts"), done])).toBe("Editing a.ts");
    expect(liveStep([done])).toBeNull();
    const child = call("execute", "Run ls", { parentToolCallId: "sub" });
    const sub = call("other", "Explore", { subagent: { kind: "Explore" } });
    expect(liveStep([sub, child])).toBeNull();
    expect(text([call("read", "Read x.ts"), sub, child])).toBe("Reading x.ts");
  });
  it("says Thinking and Writing for a live thought and message, then falls back to the verbs", () => {
    expect(text([user, thought])).toBe("Thinking…");
    expect(text([user, msg])).toBe("Writing…");
    expect(liveStep([user, msg], true)).toBeNull();
    expect(liveStep([user])).toBeNull();
    expect(liveStep([])).toBeNull();
  });
});

describe("subagent chips", () => {
  const opt = (category: string, currentValue: string, name: string) => ({
    id: category,
    name,
    category,
    currentValue,
    options: [{ value: currentValue, name, description: null }],
  });
  it("reads the parent's model and effort from its config options", () => {
    expect(inheritedOf([opt("model", "opus", "Opus"), opt("thought_level", "high", "High")])).toEqual({
      model: "Opus",
      effort: "High",
    });
    expect(inheritedOf([opt("mode", "default", "Ask")])).toEqual({ model: null, effort: null });
    expect(inheritedOf(undefined)).toEqual({ model: null, effort: null });
  });
  it("shows what the launch named, else inherits what the parent exposes, else nothing", () => {
    const parent = { model: "Opus", effort: null };
    expect(subagentChips({ model: "Haiku", effort: "low" }, parent)).toEqual([
      { key: "model", text: "Haiku", inherited: false },
      { key: "effort", text: "Low", inherited: false },
    ]);
    expect(subagentChips({}, parent)).toEqual([{ key: "model", text: "inherits Opus", inherited: true }]);
    expect(subagentChips({ model: " ", effort: null })).toEqual([]);
  });
});

describe("turnStart / formatElapsed", () => {
  it("uses the latest user message", () => {
    expect(turnStart([{ ...user, ts: 5 } as TimelineItem, msg, { ...user, ts: 9 } as TimelineItem], 1)).toBe(9);
    expect(turnStart([msg], 1)).toBe(1);
  });
  it("formats", () => {
    expect(formatElapsed(12_400)).toBe("12s");
    expect(formatElapsed(125_000)).toBe("2m 05s");
    expect(formatElapsed(-5)).toBe("0s");
  });
});

describe("turnEndOf", () => {
  const u = { ...b, kind: "user_message", text: "hi", ts: 1000 } as TimelineItem;
  const m = { ...b, kind: "agent_message", text: "ok", ts: 2000 } as TimelineItem;
  const summary = { ...b, kind: "turn_summary" } as unknown as TimelineItem;
  const cancelled = { ...b, kind: "notice", level: "info", text: "Turn cancelled" } as unknown as TimelineItem;

  it("is null while busy or without a prompt", () => {
    expect(turnEndOf("working", [u, m], m, 5000)).toBeNull();
    expect(turnEndOf("idle", [m], m, 5000)).toBeNull();
    expect(turnEndOf("interrupted", [u, m], m, 5000)).toBeNull();
  });
  it("reports Done with the turn's duration, also for answer-only turns", () => {
    expect(turnEndOf("idle", [u, m], m)).toEqual({ tone: "done", label: "Done", elapsedMs: 1000 });
  });
  it("leaves the summary card to say it", () => {
    expect(turnEndOf("idle", [u, m, summary], summary, 5000)).toBeNull();
  });
  it("distinguishes errors and user cancels", () => {
    expect(turnEndOf("error", [u, m], m, 5000)?.label).toBe("Stopped with an error");
    const errNotice = { ...b, kind: "notice", level: "error", text: "boom", ts: 3000 } as unknown as TimelineItem;
    expect(turnEndOf("error", [u, m, errNotice], errNotice)).toBeNull();
    expect(turnEndOf("idle", [u, m, cancelled], cancelled, 5000)).toMatchObject({ tone: "stopped", label: "Stopped" });
  });
  it("ignores an unknown or negative duration", () => {
    const early = { ...m, ts: 500 } as TimelineItem;
    expect(turnEndOf("idle", [u, early], early)?.elapsedMs).toBeNull();
  });
});

describe("waitingStatus", () => {
  it("shows the waiting line while working or idle, hides it when blocked or ended", () => {
    for (const s of ["working", "starting", "idle"] as const) expect(waitingStatus(s)).toBe(true);
    for (const s of ["needs_permission", "stopped", "error", "interrupted"] as const)
      expect(waitingStatus(s)).toBe(false);
  });
});
