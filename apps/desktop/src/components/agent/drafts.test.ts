import { afterEach, describe, expect, it, vi } from "vitest";
import { flushDrafts, getDraft, setDraft } from "./drafts";

function stubStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
  return data;
}

afterEach(() => vi.unstubAllGlobals());

describe("drafts", () => {
  it("keeps a big paste whole while switching agents, and only trims what is written to disk", () => {
    const data = stubStorage();
    const big = "x".repeat(30_000);
    setDraft("a1", big);
    expect(getDraft("a1")).toHaveLength(30_000);
    flushDrafts();
    const saved = JSON.parse(data.get("armada.drafts") ?? "{}") as Record<string, string>;
    expect(saved.a1).toHaveLength(20_000);
  });

  it("flushDrafts writes right away (no waiting for the debounce)", () => {
    const data = stubStorage();
    setDraft("a2", "half-typed");
    flushDrafts();
    expect(JSON.parse(data.get("armada.drafts") ?? "{}")).toMatchObject({ a2: "half-typed" });
  });

  it("an emptied draft is forgotten", () => {
    stubStorage();
    setDraft("a3", "hello");
    setDraft("a3", "");
    expect(getDraft("a3")).toBe("");
  });
});
