import { beforeEach, describe, expect, it } from "vitest";
import { MAX_PROJECTS, projectUrl, rememberProjectUrl } from "./previewMemory";

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

describe("previewMemory", () => {
  it("remembers a loopback URL per project", () => {
    expect(rememberProjectUrl("/p/a", "http://localhost:5173/")).toBe(true);
    expect(rememberProjectUrl("/p/b", "http://127.0.0.1:3000/x")).toBe(true);
    expect(projectUrl("/p/a")).toBe("http://localhost:5173/");
    expect(projectUrl("/p/b")).toBe("http://127.0.0.1:3000/x");
    expect(projectUrl("/p/none")).toBeNull();
  });
  it("never stores a remote address", () => {
    for (const bad of [
      "https://example.com",
      "http://192.168.1.2:3000",
      "http://localhost.evil.com:3000",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "http://u:p@localhost:3000",
      "",
    ]) {
      expect(rememberProjectUrl("/p/a", bad)).toBe(false);
    }
    expect(projectUrl("/p/a")).toBeNull();
  });
  it("ignores anything unsafe that is already in storage", () => {
    localStorage.setItem(
      "armada.preview.project.v1",
      JSON.stringify({ "/p/a": "https://evil.example/", "/p/b": "http://localhost:9/", "/p/c": 7 }),
    );
    expect(projectUrl("/p/a")).toBeNull();
    expect(projectUrl("/p/b")).toBe("http://localhost:9/");
    expect(projectUrl("/p/c")).toBeNull();
    localStorage.setItem("armada.preview.project.v1", "not json");
    expect(projectUrl("/p/b")).toBeNull();
  });
  it("keeps the most recently used projects", () => {
    for (let i = 0; i < MAX_PROJECTS + 5; i++) rememberProjectUrl(`/p/${i}`, `http://localhost:${3000 + i}/`);
    expect(projectUrl("/p/0")).toBeNull();
    expect(projectUrl(`/p/${MAX_PROJECTS + 4}`)).not.toBeNull();
  });
});
