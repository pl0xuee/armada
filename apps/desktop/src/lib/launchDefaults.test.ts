import { beforeEach, describe, expect, it } from "vitest";
import { choiceKey, readLaunchDefaults, rememberLaunch, resolveLaunch } from "./launchDefaults";
import { seedAccounts, seedSettings } from "./mock-data";
import type { Account } from "./types";

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
