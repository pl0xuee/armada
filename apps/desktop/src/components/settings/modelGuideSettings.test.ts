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
