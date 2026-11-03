// Saved tile divider positions ("armada.tileWeights", keyed by the main agent of a group, then by agent) are
// dropped for an agent deleted for real, and for agents that were deleted in an earlier session.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedAgents } from "@/lib/mock-data";
import type { Agent } from "@/lib/types";

let snapshot: Agent[] = [];
vi.mock("@/lib/api", () => ({
  api: {
    getState: vi.fn(async () => ({
      agents: snapshot,
      accounts: [],
      providers: [],
      settings: {},
      version: "0",
      platform: "linux",
    })),
  },
}));

const { markRemoved, suppressAgent, useApp } = await import("./app");
const { pruneTileWeights, readTileWeights, saveTileWeights } = await import("./ui");

const KEY = "armada.tileWeights";
const store = new Map<string, string>();
const saved = () => JSON.parse(store.get(KEY) ?? "{}") as Record<string, Record<string, number>>;
const put = (v: unknown) => store.set(KEY, JSON.stringify(v));

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
});
afterEach(() => vi.unstubAllGlobals());

/** Ids nobody else uses: a deleted id stays deleted for the whole file. */
let n = 0;
const ids = () => {
  const k = ++n;
  return { main: `main-${k}`, helper: `helper-${k}`, other: `other-${k}`, otherHelper: `otherh-${k}` };
};

describe("pruneTileWeights", () => {
  it("drops a gone agent's own group and its slot in other groups, and keeps the rest", () => {
    put({
      m1: { m1: 600, h1: 400 },
      m2: { m2: 500, h1: 300, h2: 200 },
      m3: { m3: 100, h3: 100 },
    });
    pruneTileWeights((id) => id !== "h1" && id !== "m3");
    expect(saved()).toEqual({ m1: { m1: 600 }, m2: { m2: 500, h2: 200 } });
  });

  it("removes a group left with nothing", () => {
    put({ m1: { h1: 400 } });
    pruneTileWeights((id) => id !== "h1");
    expect(saved()).toEqual({});
  });

  it("writes nothing when nothing is gone", () => {
    put({ m1: { m1: 600, h1: 400 } });
    const before = store.get(KEY);
    store.set(KEY, before + " "); // would be rewritten (and so lose the space) if it were saved again
    pruneTileWeights(() => true);
    expect(store.get(KEY)).toBe(before + " ");
  });

  it("leaves a damaged entry alone and never throws", () => {
    store.set(KEY, "{not json");
    expect(() => pruneTileWeights(() => false)).not.toThrow();
    expect(store.get(KEY)).toBe("{not json");
    put({ m1: "oops", m2: { m2: 1 } });
    expect(() => pruneTileWeights((id) => id !== "m2")).not.toThrow();
  });

  it("is not undone by a save still waiting for its delay", () => {
    vi.useFakeTimers();
    try {
      saveTileWeights("m1", { m1: 600, h1: 400 });
      pruneTileWeights((id) => id !== "m1");
      vi.advanceTimersByTime(1000);
      expect(saved()).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("agent deleted for real", () => {
  it("takes its group and its place in another group with it, under the same key", () => {
    const a = ids();
    put({
      [a.main]: { [a.main]: 600, [a.helper]: 400 },
      [a.other]: { [a.other]: 500, [a.main]: 200, [a.otherHelper]: 300 },
    });
    markRemoved(a.main);
    expect(saved()).toEqual({ [a.other]: { [a.other]: 500, [a.otherHelper]: 300 } });
    expect(readTileWeights(a.other, [a.other, a.otherHelper, a.main])).toEqual({
      [a.other]: 500,
      [a.otherHelper]: 300,
    });
    markRemoved(a.main); // told twice (the command and the event): no harm
    expect(saved()).toEqual({ [a.other]: { [a.other]: 500, [a.otherHelper]: 300 } });
  });

  it("keeps everything while the delete can still be undone", () => {
    const a = ids();
    put({ [a.main]: { [a.main]: 600, [a.helper]: 400 } });
    suppressAgent(a.main, true);
    suppressAgent(a.main, false);
    expect(saved()[a.main]).toEqual({ [a.main]: 600, [a.helper]: 400 });
  });
});

describe("the first agent list of a session", () => {
  const agent = (id: string, over: Partial<Agent> = {}): Agent => ({ ...seedAgents()[0], id, ...over });

  it("drops weights of agents that no longer exist, but not of archived ones", async () => {
    const a = ids();
    put({
      [a.main]: { [a.main]: 600, [a.helper]: 400 },
      [a.other]: { [a.other]: 500, [a.otherHelper]: 300 },
    });
    snapshot = [agent(a.main), agent(a.helper, { archived: true }), agent(a.other)];
    await useApp.getState().boot();
    expect(saved()).toEqual({
      [a.main]: { [a.main]: 600, [a.helper]: 400 },
      [a.other]: { [a.other]: 500 },
    });
  });

  it("does not judge anything gone from an empty list", async () => {
    const a = ids();
    put({ [a.main]: { [a.main]: 600, [a.helper]: 400 } });
    snapshot = [];
    await useApp.getState().boot();
    expect(saved()[a.main]).toBeDefined();
  });
});
