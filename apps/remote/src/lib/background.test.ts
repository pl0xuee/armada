import { describe, expect, it } from "vitest";
import {
  backgroundActive,
  backgroundDetail,
  backgroundOf,
  backgroundPill,
  backgroundShort,
  NO_BACKGROUND,
  parseBackground,
  statusWith,
  withSubagents,
} from "./background";
import { composerPlaceholders } from "./composerLogic";
import { needsReason, triageQueue } from "./triage";
import type { Agent } from "./types";

const wf = (workflows: number, working: number, total: number, subagents = 0) => ({ workflows, working, total, subagents });
const agent = (extra: Partial<Agent> = {}): Agent =>
  ({ id: "a1", title: "A", status: "idle", archived: false, unread: true, rateLimited: false, pendingPermissions: 0, acknowledgedAt: null, lastActivityAt: 1000, projectPath: "/p", ...extra }) as Agent;

describe("wording (the desktop's lib/background)", () => {
  it("says how far a workflow is", () => {
    expect(backgroundShort(wf(1, 3, 5))).toBe("Workflow 3 of 5 running");
    expect(backgroundShort(wf(1, 0, 5))).toBe("Workflow wrapping up");
    expect(backgroundShort(wf(1, 0, 0))).toBe("Workflow running");
    expect(backgroundShort(wf(2, 4, 9))).toBe("2 workflows running");
    expect(backgroundShort(wf(0, 0, 0, 2))).toBe("2 background agents may be running");
    expect(backgroundPill(wf(1, 3, 5))).toBe("Turn finished · Workflow 3 of 5 running");
    expect(backgroundDetail(wf(1, 3, 5))).toBe("Its turn finished. A workflow is still running: 3 of 5 agents working.");
  });

  it("an idle agent with a workflow reads as working, not Idle", () => {
    expect(statusWith(agent(), wf(1, 3, 5))).toEqual({ status: "working", label: "Workflow 3 of 5 running" });
    expect(statusWith(agent(), NO_BACKGROUND)).toEqual({ status: "idle", label: null });
  });

  it("composer placeholder names what is still running", () => {
    expect(composerPlaceholders(agent(), "Claude", false, "workflow")[0]).toBe("Turn finished. A workflow is still running. Reply, or start something new…");
    expect(composerPlaceholders(agent(), "Claude", false, "agents")[0]).toContain("Background agents may still be running");
    expect(composerPlaceholders(agent(), "Claude", false, null)[0]).toBe("Done. Reply, or start something new…");
  });
});

describe("what the server says", () => {
  it("keeps only whole, positive counts", () => {
    expect(parseBackground({ agents: { a: { workflows: 1, working: 3, total: 5 }, b: { workflows: 0, working: 1, total: 1 }, c: null, d: { workflows: "x" } } })).toEqual({
      a: wf(1, 3, 5),
    });
    expect(parseBackground(null)).toEqual({});
    expect(parseBackground({ agents: [] })).toEqual({});
    expect(parseBackground({ agents: { a: { workflows: 1.9, working: -2, total: NaN } } })).toEqual({ a: wf(1, 0, 0) });
  });

  it("only an idle, unarchived agent has anything behind its turn", () => {
    const known = wf(1, 3, 5);
    expect(backgroundOf(agent(), known)).toBe(known);
    expect(backgroundOf(agent({ status: "working" }), known)).toBe(NO_BACKGROUND);
    expect(backgroundOf(agent({ status: "stopped" }), known)).toBe(NO_BACKGROUND);
    expect(backgroundOf(agent({ archived: true }), known)).toBe(NO_BACKGROUND);
    expect(backgroundOf(agent(), undefined)).toBe(NO_BACKGROUND);
    expect(backgroundActive(withSubagents(NO_BACKGROUND, 2))).toBe(true);
    expect(withSubagents(known, 0)).toBe(known);
  });
});

describe("Needs you: not done while a workflow runs", () => {
  it("an unread idle agent is 'done' only once the work behind its turn ended", () => {
    expect(needsReason(agent())).toBe("done");
    expect(needsReason(agent(), undefined, true)).toBeNull();
    // Blocking reasons still win.
    expect(needsReason(agent({ pendingPermissions: 1 }), undefined, true)).toBe("permission");
    expect(needsReason(agent({ rateLimited: true }), undefined, true)).toBe("rate_limited");
  });

  it("the queue leaves the agent out and brings it back when the workflow ends", () => {
    const a = agent();
    expect(triageQueue([a], undefined, () => true)).toEqual([]);
    expect(triageQueue([a], undefined, () => false).map((e) => e.reason)).toEqual(["done"]);
  });
});
