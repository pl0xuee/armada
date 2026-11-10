import { beforeEach, describe, expect, it, vi } from "vitest";

const patchSettings = vi.fn();
let tokenSaver: { subagentModel: string | null } | null = null;
vi.mock("@/store/app", () => ({
  useApp: { getState: () => ({ settings: tokenSaver && { tokenSaver }, patchSettings }) },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { readWorkChoice } from "@/lib/modelGuide";
import { applyRecommendedModels } from "./ModelGuideSettings";

beforeEach(() => {
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
  patchSettings.mockReset().mockResolvedValue(undefined);
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  tokenSaver = { subagentModel: null };
});

describe("the recommended model setup", () => {
  it("starts new agents on everyday coding and puts helpers on Sonnet", async () => {
    expect(await applyRecommendedModels()).toBe(true);
    expect(readWorkChoice()).toBe("everyday");
    expect(patchSettings).toHaveBeenCalledWith({ tokenSaver: { subagentModel: "sonnet" } });
    expect(toast.success).toHaveBeenCalledOnce();
  });

  it("keeps a helper model you already chose", async () => {
    tokenSaver = { subagentModel: "haiku" };
    expect(await applyRecommendedModels()).toBe(true);
    expect(patchSettings).not.toHaveBeenCalled();
    expect(readWorkChoice()).toBe("everyday");
    expect(vi.mocked(toast.success).mock.calls[0][1]?.description).toContain("Haiku");
  });

  it("changes nothing when the helper setting cannot be saved", async () => {
    patchSettings.mockRejectedValue(new Error("disk full"));
    expect(await applyRecommendedModels()).toBe(false);
    expect(readWorkChoice()).toBeNull();
    expect(toast.error).toHaveBeenCalledOnce();
    expect(toast.success).not.toHaveBeenCalled();
  });
});

const setAgentConfig = vi.fn();
vi.mock("@/lib/api", () => ({ api: { setAgentConfig: (...a: unknown[]) => setAgentConfig(...a) } }));

import type { Agent } from "@/lib/types";
import { switchAgentsToRecommended } from "./ModelGuideSettings";

describe("switching the agents you have", () => {
  const opt = (id: string, currentValue: string) => ({ id, name: id, category: null, currentValue, options: [] });
  const target = (id: string, model?: string, effort?: string) => ({
    agent: {
      id,
      provider: "claude",
      configOptions: [...(model ? [opt("model", model)] : []), ...(effort ? [opt("effort", effort)] : [])],
    } as unknown as Agent,
    long: false,
  });

  beforeEach(() => setAgentConfig.mockReset().mockResolvedValue(undefined));

  it("changes the model first, then effort, and only what differs", async () => {
    expect(await switchAgentsToRecommended([target("a", "sonnet", "high"), target("b", "opus", "low")])).toBe(0);
    expect(setAgentConfig.mock.calls).toEqual([
      ["a", "model", "opus"],
      ["b", "effort", "medium"],
      ["a", "effort", "medium"],
    ]);
    expect(toast.success).toHaveBeenCalledOnce();
  });

  it("sets both on an agent that hasn't reported its options", async () => {
    await switchAgentsToRecommended([target("c")]);
    expect(setAgentConfig.mock.calls).toEqual([
      ["c", "model", "opus"],
      ["c", "effort", "medium"],
    ]);
  });

  it("says how many failed", async () => {
    setAgentConfig.mockImplementation(async (id: string) => {
      if (id === "bad") throw new Error("not responding");
    });
    expect(await switchAgentsToRecommended([target("ok", "sonnet", "medium"), target("bad", "sonnet", "medium")])).toBe(
      1,
    );
    expect(toast.error).toHaveBeenCalledWith("Couldn't switch 1 of 2 agents");
  });
});

describe("switching agents also sets helpers", () => {
  const sonnetAgent = {
    agent: {
      id: "s",
      provider: "claude",
      configOptions: [{ id: "model", name: "model", category: null, currentValue: "sonnet", options: [] }],
    } as unknown as Agent,
    long: false,
  };

  beforeEach(() => setAgentConfig.mockReset().mockResolvedValue(undefined));

  it("puts helpers on Sonnet when none is chosen", async () => {
    await switchAgentsToRecommended([sonnetAgent]);
    expect(patchSettings).toHaveBeenCalledWith({ tokenSaver: { subagentModel: "sonnet" } });
    expect(vi.mocked(toast.success).mock.calls[0][1]?.description).toContain("Helpers run on Sonnet");
  });

  it("keeps a helper model you already chose", async () => {
    tokenSaver = { subagentModel: "haiku" };
    await switchAgentsToRecommended([sonnetAgent]);
    expect(patchSettings).not.toHaveBeenCalled();
    expect(vi.mocked(toast.success).mock.calls[0][1]?.description).toContain("Helpers run on Haiku");
  });

  it("switches nothing when the helper setting can't be saved", async () => {
    patchSettings.mockRejectedValue(new Error("disk full"));
    expect(await switchAgentsToRecommended([sonnetAgent])).toBe(1);
    expect(setAgentConfig).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledOnce();
  });
});
