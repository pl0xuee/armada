import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import {
  choiceKey,
  clampAgentCount,
  launchAgents,
  MAX_PARALLEL_AGENTS,
  needsWorktree,
  readLaunchDefaults,
  rememberLaunch,
  resolveLaunch,
} from "./launchDefaults";
import { seedAccounts, seedSettings } from "./mock-data";
import type { Account, Agent, CreateAgentRequest } from "./types";

// Tiny in-memory localStorage for node.
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
});

const accounts: Account[] = seedAccounts().filter((a) => a.provider !== "custom");
const settings = seedSettings(true);

describe("choiceKey", () => {
  it("keys built-ins by provider and custom agents by id", () => {
    expect(choiceKey("codex", null)).toBe("codex");
    expect(choiceKey("custom", "ca-gemini")).toBe("custom:ca-gemini");
    expect(choiceKey("custom", null)).toBe("custom");
  });
});

describe("resolveLaunch", () => {
  it("defaults to Claude, the first recent project and the worktree setting", () => {
    const r = resolveLaunch(accounts, settings);
    expect(r.provider).toBe("claude");
    expect(accounts.find((a) => a.id === r.accountId)?.provider).toBe("claude");
    expect(r.folder).toBe(settings.recentProjects[0]);
    expect(r.worktree).toBe(settings.defaultWorktree);
  });

  it("round-trips a remembered launch", () => {
    rememberLaunch({
      provider: "codex",
      accountId: "acc-codex-api",
      customAgentId: null,
      folder: "/home/sam/Projects/infra",
      worktree: false,
    });
    expect(readLaunchDefaults().choice).toBe("codex");
    const r = resolveLaunch(accounts, settings);
    expect([r.provider, r.accountId, r.folder, r.worktree]).toEqual([
      "codex",
      "acc-codex-api",
      "/home/sam/Projects/infra",
      false,
    ]);
  });

  it("resolves an enabled custom agent", () => {
    rememberLaunch({
      provider: "custom",
      accountId: "system-custom",
      customAgentId: "ca-gemini",
      folder: "/p",
      worktree: true,
    });
    const r = resolveLaunch(accounts, settings);
    expect([r.provider, r.customAgentId]).toEqual(["custom", "ca-gemini"]);
  });

  it("falls back from a disabled custom agent to a built-in provider", () => {
    rememberLaunch({
      provider: "custom",
      accountId: "system-custom",
      customAgentId: "ca-goose",
      folder: "/p",
      worktree: true,
    });
    expect(resolveLaunch(accounts, settings).provider).toBe("claude");
  });

  it("keeps the remembered provider even when its account is signed out", () => {
    rememberLaunch({ provider: "grok", accountId: "acc-grok-sys", customAgentId: null, folder: "/p", worktree: true });
    // Grok's only account is signed out, but it's what the user picked: keep it.
    expect(resolveLaunch(accounts, settings).provider).toBe("grok");
  });

  it("survives corrupt storage", () => {
    localStorage.setItem("armada.launchDefaults", "{not json");
    expect(readLaunchDefaults().choice).toBe("claude");
  });
});

describe("starting several agents", () => {
  const target = { ...resolveLaunch(accounts, settings), folder: "/work/app", worktree: false };
  afterEach(() => vi.restoreAllMocks());

  it("allows 1 to 8", () => {
    expect(MAX_PARALLEL_AGENTS).toBe(8);
    expect([0, -3, 1, 4.9, 8, 9, 100, NaN].map(clampAgentCount)).toEqual([1, 1, 1, 4, 8, 8, 8, 1]);
    expect(needsWorktree(1)).toBe(false);
    expect(needsWorktree(2)).toBe(true);
  });

  it("starts that many agents, each in its own worktree, and remembers the launch", async () => {
    const reqs: CreateAgentRequest[] = [];
    vi.spyOn(api, "createAgent").mockImplementation(async (r) => {
      reqs.push(r);
      return { id: `a${reqs.length}` } as Agent;
    });
    const { created, failed } = await launchAgents(target, "  fix it ", "auto", 8);
    expect(created).toHaveLength(8);
    expect(failed).toEqual([]);
    expect(reqs).toHaveLength(8);
    expect(reqs.every((r) => r.worktree && r.prompt === "fix it" && r.projectPath === "/work/app")).toBe(true);
    // The remembered preference is the user's own, not the forced one.
    expect(readLaunchDefaults().worktree).toBe(false);
  });

  it("never starts more than 8", async () => {
    const spy = vi.spyOn(api, "createAgent").mockResolvedValue({ id: "x" } as Agent);
    await launchAgents(target, "go", null, 50);
    expect(spy).toHaveBeenCalledTimes(8);
  });

  it("leaves a single agent's worktree setting alone", async () => {
    const spy = vi.spyOn(api, "createAgent").mockResolvedValue({ id: "x" } as Agent);
    await launchAgents(target, "go", null, 1);
    expect(spy.mock.calls[0][0].worktree).toBe(false);
  });

  it("reports the agents that failed and keeps the ones that started", async () => {
    let n = 0;
    vi.spyOn(api, "createAgent").mockImplementation(async () => {
      if (++n % 2 === 0) throw new Error("worktree busy");
      return { id: `a${n}` } as Agent;
    });
    const { created, failed } = await launchAgents(target, "go", null, 4);
    expect(created).toHaveLength(2);
    expect(failed).toEqual(["worktree busy", "worktree busy"]);
  });

  it("remembers nothing when every agent failed", async () => {
    vi.spyOn(api, "createAgent").mockRejectedValue(new Error("no"));
    const { created, failed } = await launchAgents({ ...target, folder: "/never" }, "go", null, 2);
    expect(created).toEqual([]);
    expect(failed).toHaveLength(2);
    expect(readLaunchDefaults().folder).not.toBe("/never");
  });

  it("keeps a retried agent isolated and in its batch's group", async () => {
    const spy = vi.spyOn(api, "createAgent").mockResolvedValue({ id: "x" } as Agent);
    const first = await launchAgents(target, "go", null, 3);
    expect(first.groupId).toBeTruthy();
    // Two started, one failed: the retry is a single agent, but must not fall back to the main checkout.
    spy.mockClear();
    const retry = await launchAgents(target, "go", null, 1, first.groupId);
    expect(retry.groupId).toBe(first.groupId);
    expect(spy.mock.calls[0][0]).toMatchObject({ worktree: true, groupId: first.groupId });
  });

  it("turns a synchronous throw into a failed agent instead of escaping", async () => {
    vi.spyOn(api, "createAgent").mockImplementation(() => {
      throw new Error("boom");
    });
    const { created, failed } = await launchAgents(target, "go", null, 2);
    expect(created).toEqual([]);
    expect(failed).toEqual(["boom", "boom"]);
  });
});
