import { beforeEach, describe, expect, it } from "vitest";
import { cacheThemeChoice, THEME_CACHE_KEY } from "./themes";

// Tiny in-memory localStorage for node.
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
});

describe("cacheThemeChoice", () => {
  it("remembers a theme and the system choice under the new key", () => {
    expect(THEME_CACHE_KEY).toBe("kvistcode.theme");
    cacheThemeChoice("paper");
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBe("paper");
    cacheThemeChoice("system");
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBe("system");
  });

  it("ignores a missing or unknown choice, so the settings-not-loaded gap never overwrites it", () => {
    cacheThemeChoice("lilac");
    cacheThemeChoice(undefined);
    cacheThemeChoice("nope");
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBe("lilac");
  });
});
