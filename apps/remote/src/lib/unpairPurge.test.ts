import { describe, expect, it, vi } from "vitest";

// Unpairing forgets what this phone remembered about that desktop, not only the drafts.
describe("purgeAllDrafts", () => {
  it("also clears the last project and the remembered groups", async () => {
    const store = new Map<string, string>([
      ["armada.draft.a1", "hello"],
      ["armada.newAgent.last", '{"projectPath":"/work/secret"}'],
      ["armada.together", '[["a1","a2"]]'],
      ["armada.other", "kept"],
    ]);
    const fake = {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    vi.stubGlobal("localStorage", fake);
    const { purgeAllDrafts } = await import("./drafts");
    purgeAllDrafts();
    expect([...store.keys()]).toEqual(["armada.other"]);
    vi.unstubAllGlobals();
  });
});
