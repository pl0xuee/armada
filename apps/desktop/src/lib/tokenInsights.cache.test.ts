import { describe, expect, it } from "vitest";
import { tokenInsights } from "./tokenInsights";
import type { Agent, Settings } from "./types";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const agent = (over: Partial<Agent> = {}): Agent =>
  ({
    id: "a1",
    title: "Refactor",
    provider: "claude",
    accountId: "acc",
    status: "idle",
    archived: false,
    costUsd: 1,
    tokensUsed: 500_000,
    contextUsed: 20_000,
    contextSize: 200_000,
    lastActivityAt: NOW - 5 * MIN,
    configOptions: [],
    ...over,
  }) as Agent;

const settings = (subagentModel: string | null = "sonnet"): Settings =>
  ({
    autoCompactWindow: 250_000,
    mcpServers: [],
    tokenSaver: { outputFilter: true, bashOutputMaxChars: 12_000, subagentModel },
  }) as unknown as Settings;

const ids = (agents: Agent[], s: Settings | null = settings()) =>
  tokenInsights({ agents, accounts: [], settings: s, now: NOW }).map((i) => i.id);

describe("cold prompt cache insight", () => {
  it("warns about a big agent idle for over an hour", () => {
    const out = tokenInsights({
      agents: [agent({ contextUsed: 300_000, lastActivityAt: NOW - 75 * MIN })],
      accounts: [],
      settings: settings(),
      now: NOW,
    });
    const cold = out.find((i) => i.id === "cold-cache");
    expect(cold?.title).toContain("idle over an hour");
    expect(cold?.action).toMatchObject({ kind: "open-agent", agentId: "a1" });
  });

  it("stays quiet for small, recent, busy or non-Claude agents", () => {
    const idle = NOW - 90 * MIN;
    expect(ids([agent({ contextUsed: 100_000, lastActivityAt: idle })])).not.toContain("cold-cache");
    expect(ids([agent({ contextUsed: 300_000, lastActivityAt: NOW - 20 * MIN })])).not.toContain("cold-cache");
    expect(ids([agent({ contextUsed: 300_000, lastActivityAt: idle, status: "working" })])).not.toContain("cold-cache");
    expect(ids([agent({ contextUsed: 300_000, lastActivityAt: idle, provider: "codex" })])).not.toContain("cold-cache");
    expect(ids([agent({ contextUsed: 300_000, lastActivityAt: idle, archived: true })])).not.toContain("cold-cache");
  });
});

describe("helper model insight", () => {
  it("suggests the preset for a heavy Claude setup without a helper model", () => {
    const heavy = agent({ tokensUsed: 6_000_000 });
    expect(ids([heavy], settings(null))).toContain("helper-model");
    expect(ids([heavy], settings("sonnet"))).not.toContain("helper-model");
    expect(ids([agent()], settings(null))).not.toContain("helper-model");
  });
});
