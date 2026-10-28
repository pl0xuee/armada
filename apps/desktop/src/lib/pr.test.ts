import { describe, expect, it } from "vitest";
import { agentsToPoll, ciSummary, formatDuration, listIndicator } from "./pr";
import type { Agent, PrInfo, PrStatus } from "./types";

const agent = (over: Partial<Agent>): Agent =>
  ({ id: "a", branch: "b", worktree: true, archived: false, status: "idle", lastActivityAt: 0, ...over }) as Agent;

const pr = (over: Partial<PrInfo["summary"]>, state: PrInfo["state"] = "open"): PrInfo => ({
  number: 1,
  url: "u",
  title: "t",
  state,
  review: null,
  mergeable: null,
  checks: [],
  summary: { passing: 0, failing: 0, pending: 0, overall: "none", ...over },
});

describe("pr helpers", () => {
  it("formats durations", () => {
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(41)).toBe("41s");
    expect(formatDuration(123)).toBe("2m 03s");
    expect(formatDuration(3725)).toBe("1h 02m");
  });

  it("summarizes CI", () => {
    expect(ciSummary(pr({ failing: 2, overall: "failing" }))).toBe("2 checks failing");
    expect(ciSummary(pr({ pending: 1, overall: "pending" }))).toBe("1 check running");
    expect(ciSummary(pr({}))).toBe("No checks");
  });

  it("polls the selected, working and recently active branch agents only", () => {
    const now = 10_000_000;
    const list = [
      agent({ id: "sel", lastActivityAt: 0 }),
      agent({ id: "work", status: "working" }),
      agent({ id: "recent", lastActivityAt: now - 60_000 }),
      agent({ id: "old", lastActivityAt: 0 }),
      agent({ id: "nobranch", branch: null, status: "working" }),
      agent({ id: "archived", archived: true, status: "working" }),
    ];
    expect(agentsToPoll(list, "sel", now)).toEqual(["sel", "work", "recent"]);
  });

  it("shows a list indicator only for live PRs", () => {
    const ok = (p: PrInfo): PrStatus => ({ state: "ok", reason: null, pr: p, fetchedAt: 0 });
    expect(listIndicator(ok(pr({})))).not.toBeNull();
    expect(listIndicator(ok(pr({}, "merged")))).toBeNull();
    expect(listIndicator(undefined)).toBeNull();
  });
});
