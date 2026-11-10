import { describe, expect, it } from "vitest";
import { tokenInsights } from "./tokenInsights";
import type { Account, Agent, Settings } from "./types";

const NOW = 1_800_000_000_000;

const agent = (over: Partial<Agent> = {}): Agent =>
  ({
    id: "a1",
    title: "Fix tests",
    provider: "claude",
    accountId: "acc",
    status: "idle",
    archived: false,
    costUsd: 1,
    tokensUsed: 500_000,
    contextUsed: 20_000,
    contextSize: 200_000,
    configOptions: [],
    ...over,
  }) as Agent;

const effort = (v: string) => [{ id: "effort", name: "Effort", category: "thought_level", currentValue: v, options: [] }];
const settings = (over: Partial<Settings> = {}): Settings => ({ autoCompactWindow: null, mcpServers: [], ...over }) as Settings;
const account = (usedPercent: number | null): Account =>
  ({
    id: "acc",
    name: "Work",
    usage:
      usedPercent == null
        ? null
        : { primary: { usedPercent, windowMins: 300, resetsAt: NOW + 90 * 60_000 }, secondary: null, plan: null, updatedAt: NOW },
  }) as Account;

const ids = (agents: Agent[], s: Settings | null = settings(), accounts: Account[] = [account(null)]) =>
  tokenInsights({ agents, accounts, settings: s, now: NOW }).map((i) => i.id);

describe("tokenInsights", () => {
  it("says nothing about a small, calm setup", () => {
    expect(ids([agent(), agent({ id: "a2" })])).toEqual([]);
  });

  it("flags long contexts and points at the biggest agent", () => {
    const out = tokenInsights({
      agents: [agent({ id: "big", contextUsed: 480_000, title: "Big" }), agent({ id: "mid", contextUsed: 220_000 })],
      accounts: [],
      settings: settings({ autoCompactWindow: 250_000 }),
      now: NOW,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "long-context", severity: "high" });
    expect(out[0].action).toMatchObject({ kind: "open-agent", agentId: "big" });
  });

  it("ignores archived agents", () => {
    expect(ids([agent({ contextUsed: 480_000, archived: true })])).toEqual([]);
  });

  it("recommends the preset for 1M-context Claude agents with no compact size", () => {
    const big = agent({ contextSize: 1_000_000 });
    expect(ids([big])).toContain("compact-window");
    expect(ids([big], settings({ autoCompactWindow: 250_000 }))).not.toContain("compact-window");
    expect(ids([agent({ ...big, provider: "codex" })])).not.toContain("compact-window");
    const [i] = tokenInsights({ agents: [big], accounts: [], settings: settings(), now: NOW });
    expect(i.action).toEqual({ kind: "preset", label: "Save tokens" });
  });

  it("offers to lower high effort on Claude agents only", () => {
    const a = agent({ id: "h1", configOptions: effort("high") });
    const b = agent({ id: "h2", configOptions: effort("max") });
    const c = agent({ id: "m1", configOptions: effort("medium") });
    const x = agent({ id: "x1", provider: "codex", configOptions: effort("high") });
    const out = tokenInsights({ agents: [a, b, c, x], accounts: [], settings: settings(), now: NOW });
    const e = out.find((i) => i.id === "effort")!;
    expect(e.action).toMatchObject({ kind: "lower-effort", agentIds: ["h1", "h2"] });
  });

  it("flags an agent that costs far more per token", () => {
    const cheap = agent({ id: "c", tokensUsed: 10_000_000, costUsd: 5 });
    const dear = agent({ id: "d", tokensUsed: 10_000_000, costUsd: 42, title: "Dear" });
    const out = tokenInsights({ agents: [cheap, dear], accounts: [], settings: settings(), now: NOW });
    const p = out.find((i) => i.id === "pricey")!;
    expect(p.title).toContain("$4.20");
    expect(p.action).toMatchObject({ agentId: "d" });
    expect(ids([cheap, agent({ id: "e", tokensUsed: 500, costUsd: 9 })])).not.toContain("pricey");
  });

  it("warns when many agents work at once on one account", () => {
    const busy = (n: number) => Array.from({ length: n }, (_, i) => agent({ id: `w${i}`, status: "working" }));
    expect(ids(busy(3))).toEqual([]);
    expect(ids(busy(4))).toEqual(["parallel:acc"]);
    const out = tokenInsights({ agents: busy(2), accounts: [account(70)], settings: settings(), now: NOW });
    expect(out[0].id).toBe("parallel:acc");
    expect(out[0].title).toContain("5-hour window is 70% used");
    expect(out[0].detail).toContain("Resets in 90 min");
    expect(ids(busy(2), settings(), [account(30)])).toEqual([]);
  });

  it("ignores a usage window that has already reset", () => {
    const stale: Account = {
      ...account(95),
      usage: { primary: { usedPercent: 95, windowMins: 300, resetsAt: NOW - 1 }, secondary: null, plan: null, updatedAt: NOW },
    };
    const two = [agent({ id: "w1", status: "working" }), agent({ id: "w2", status: "working" })];
    expect(ids(two, settings(), [stale])).toEqual([]);
  });

  it("puts the urgent things first", () => {
    const out = tokenInsights({
      agents: [
        agent({ id: "e", configOptions: effort("high") }),
        agent({ id: "big", contextUsed: 400_000, contextSize: 1_000_000 }),
      ],
      accounts: [],
      settings: settings(),
      now: NOW,
    });
    expect(out[0].severity).toBe("high");
    expect(out.map((i) => i.severity)).toEqual([...out.map((i) => i.severity)].sort((a, b) => "high medium info".indexOf(a) - "high medium info".indexOf(b)));
  });
});

describe("the helper-model insight", () => {
  const heavy = [agent({ tokensUsed: 2_500_000, costUsd: 1 })];
  const saver = (subagentModel: string | null) =>
    settings({ tokenSaver: { outputFilter: false, bashOutputMaxChars: null, subagentModel } });

  it("offers Sonnet for helpers on its own, not the whole preset", () => {
    const i = tokenInsights({ agents: heavy, accounts: [account(null)], settings: saver(null), now: NOW }).find(
      (x) => x.id === "helper-model",
    )!;
    expect(i.action).toEqual({ kind: "helper-model", model: "sonnet", label: "Use Sonnet for helpers" });
  });

  it("is quiet once helpers have a model, or for light use", () => {
    expect(ids(heavy, saver("sonnet"))).not.toContain("helper-model");
    expect(ids([agent({ tokensUsed: 100_000 })], saver(null))).not.toContain("helper-model");
  });
});
