import { beforeEach, describe, expect, it } from "vitest";
import {
  cleanServerUrl,
  describeModel,
  formatBytes,
  formatContext,
  isLoopbackUrl,
  pickLocalModel,
  pullPercent,
  pullText,
  recallLocalModel,
  rememberLocalModel,
  serverStatusText,
} from "./local";
import type { LocalModel } from "./types";

// Tiny in-memory localStorage for node.
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  clear() {
    this.m.clear();
  }
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
});

const model = (over: Partial<LocalModel> = {}): LocalModel => ({
  id: "m",
  sizeBytes: null,
  parameters: null,
  quantization: null,
  contextLength: null,
  tools: null,
  ...over,
});

describe("local model helpers", () => {
  it("describes models, skipping unknown fields", () => {
    expect(describeModel(model())).toBe("");
    expect(
      describeModel(
        model({ parameters: "30.5B", quantization: "Q4_K_M", contextLength: 262144, sizeBytes: 18_556_701_776 }),
      ),
    ).toBe("30.5B · Q4_K_M · 256k context · 18.6 GB");
  });

  it("formats sizes and context", () => {
    expect(formatBytes(5_200_000_000)).toBe("5.2 GB");
    expect(formatBytes(420_000_000)).toBe("420 MB");
    expect(formatContext(32768)).toBe("32k");
    expect(formatContext(4096)).toBe("4k");
    expect(formatContext(2_000_000)).toBe("2M");
    expect(formatContext(512)).toBe("512");
  });

  it("words server status", () => {
    expect(serverStatusText(true, 4)).toBe("Running · 4 models");
    expect(serverStatusText(true, 1)).toBe("Running · 1 model");
    expect(serverStatusText(false, 0)).toBe("Not running");
  });

  it("restricts addresses to http(s) and spots loopback", () => {
    expect(cleanServerUrl(" http://gpu-box:8000/v1/ ")).toBe("http://gpu-box:8000/v1");
    expect(cleanServerUrl("ftp://x")).toBeNull();
    expect(cleanServerUrl("localhost:1234")).toBeNull();
    expect(cleanServerUrl("http://a b")).toBeNull();
    expect(cleanServerUrl("http://x?y=1")).toBeNull();
    expect(isLoopbackUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isLoopbackUrl("http://localhost:8080/v1")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:8080")).toBe(true);
    expect(isLoopbackUrl("http://192.168.1.5:8000")).toBe(false);
    expect(isLoopbackUrl("https://localhost.evil.com")).toBe(false);
    expect(isLoopbackUrl("http://127.evil.com")).toBe(false);
    expect(isLoopbackUrl("http://0.0.0.0:11434")).toBe(false);
    expect(isLoopbackUrl("http://127.1.2.3")).toBe(true);
    expect(isLoopbackUrl("http://localhost@evil.com")).toBe(false);
    expect(isLoopbackUrl("nonsense")).toBe(false);
  });

  it("reports pull progress", () => {
    expect(pullPercent({ total: null, completed: null })).toBeNull();
    expect(pullPercent({ total: 200, completed: 50 })).toBe(25);
    expect(pullText({ status: "pulling manifest", total: null, completed: null, done: false, error: null })).toBe(
      "pulling manifest",
    );
    expect(
      pullText({ status: "pulling x", total: 5_200_000_000, completed: 2_600_000_000, done: false, error: null }),
    ).toBe("50% · 2.6 GB of 5.2 GB");
  });

  describe("remembered model", () => {
    it("prefers the remembered model while the server still has it", () => {
      const models = [model({ id: "a" }), model({ id: "b" })];
      expect(pickLocalModel(models, "b")).toBe("b");
      expect(pickLocalModel(models, "gone")).toBe("a");
      expect(pickLocalModel([], "b")).toBe("");
    });

    it("stores one model per account", () => {
      expect(recallLocalModel("acc1")).toBeNull();
      rememberLocalModel("acc1", "qwen3:8b");
      rememberLocalModel("acc2", "gpt-oss:20b");
      expect(recallLocalModel("acc1")).toBe("qwen3:8b");
      expect(recallLocalModel("acc2")).toBe("gpt-oss:20b");
    });
  });
});
