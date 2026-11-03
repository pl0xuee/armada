import { beforeEach, describe, expect, it } from "vitest";
import { followProjectMove, readLaunchDefaults, saveLaunchDefaults } from "./launchDefaults";

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

describe("followProjectMove", () => {
  it("points the remembered launch folder at the project's new place", () => {
    saveLaunchDefaults({ folder: "/home/me/Projects/Foo", choice: "codex" });
    followProjectMove("/home/me/Projects/Foo", "/home/me/Projects/Bar");
    const d = readLaunchDefaults();
    expect(d.folder).toBe("/home/me/Projects/Bar");
    // The other remembered choices stay as they were.
    expect(d.choice).toBe("codex");
  });

  it("matches the folder whatever trailing separator either side has", () => {
    saveLaunchDefaults({ folder: "/home/me/Projects/Foo/" });
    followProjectMove("/home/me/Projects/Foo", "/home/me/Projects/Bar");
    expect(readLaunchDefaults().folder).toBe("/home/me/Projects/Bar");
  });

  it("leaves another project's folder alone", () => {
    saveLaunchDefaults({ folder: "/home/me/Projects/Other" });
    followProjectMove("/home/me/Projects/Foo", "/home/me/Projects/Bar");
    expect(readLaunchDefaults().folder).toBe("/home/me/Projects/Other");
  });

  it("does nothing when no folder is remembered", () => {
    followProjectMove("/home/me/Projects/Foo", "/home/me/Projects/Bar");
    expect(readLaunchDefaults().folder).toBeNull();
  });
});
