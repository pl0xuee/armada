import { describe, expect, it } from "vitest";
import {
  bestFor,
  CATALOG,
  contextVerdict,
  describeHardware,
  diskAllows,
  fitModel,
  pickContext,
  rankedCatalog,
} from "./localFit";
import type { Hardware } from "./types";

const GIB = 1 << 30;

function hw(over: Partial<Hardware> = {}): Hardware {
  return {
    os: "linux",
    ramBytes: 64 * GIB,
    gpus: [{ name: "NVIDIA GeForce RTX 4090", vendor: "nvidia", vramBytes: 24 * GIB }],
    unifiedMemory: false,
    accel: "gpu",
    modelMemoryBytes: 24 * GIB,
    modelsDir: null,
    diskFreeBytes: 200e9,
    ...over,
  };
}
const model = (name: string) => CATALOG.find((m) => m.name === name)!;

describe("context choice (mirrors the Rust pick_context)", () => {
  it("uses 64k when memory allows and shrinks when it doesn't", () => {
    expect(pickContext(262144, 48 * GIB, 19 * GIB, 96 * 1024)).toBe(65536);
    expect(pickContext(32768, 48 * GIB, 19 * GIB, 96 * 1024)).toBe(32768);
    expect(pickContext(262144, 24 * GIB, 19 * GIB, 96 * 1024)).toBe(32768);
    expect(pickContext(262144, 22 * GIB, 19 * GIB, 96 * 1024)).toBe(16384);
    expect(pickContext(262144, GIB, 19 * GIB, 96 * 1024)).toBe(8192);
    expect(pickContext(null, null, null, 1)).toBe(65536);
    expect(pickContext(131072, GIB, 19e9, 1, 100000)).toBe(100000);
    expect(pickContext(8192, null, null, 1, 100000)).toBe(8192);
  });

  it("judges a window", () => {
    expect(contextVerdict(65536).ok).toBe(true);
    expect(contextVerdict(4096)).toEqual({ ok: false, text: expect.stringContaining("small for agent work") });
  });
});

describe("what fits", () => {
  it("fits a 30B model on a 24 GB card, with a smaller window than a 48 GB card", () => {
    const on24 = fitModel(model("qwen3-coder:30b"), hw());
    expect(on24.level).toBe("ok");
    expect(on24.context).toBe(49152);
    const on48 = fitModel(model("qwen3-coder:30b"), hw({ modelMemoryBytes: 48 * GIB }));
    expect(on48.level).toBe("great");
  });

  it("says no or slow when it doesn't fit", () => {
    const small = hw({ modelMemoryBytes: 8 * GIB, ramBytes: 32 * GIB });
    expect(fitModel(model("gpt-oss:20b"), small).level).toBe("slow");
    expect(fitModel(model("gpt-oss:120b"), small).level).toBe("no");
    const cpu = hw({ accel: "cpu", gpus: [], modelMemoryBytes: 9.6 * GIB, ramBytes: 16 * GIB });
    expect(fitModel(model("qwen3.5:9b"), cpu).level).toBe("slow");
    expect(fitModel(model("qwen3-coder:30b"), cpu).level).toBe("no");
  });

  it("doesn't pretend when memory is unknown", () => {
    expect(fitModel(model("gpt-oss:20b"), null).level).toBe("unknown");
    expect(fitModel(model("gpt-oss:20b"), hw({ modelMemoryBytes: null })).level).toBe("unknown");
  });

  it("recommends the strongest model that runs well", () => {
    expect(bestFor(hw())?.name).toBe("qwen3-coder:30b");
    expect(bestFor(hw({ modelMemoryBytes: 16 * GIB }))?.quality).toBe("starter");
    expect(bestFor(hw({ modelMemoryBytes: 4 * GIB, ramBytes: 8 * GIB }))).toBeNull();
    const ranked = rankedCatalog(hw());
    expect(ranked[0].best).toBe(true);
    expect(ranked[ranked.length - 1].fit.level).toBe("no");
  });

  it("checks disk space with 10% spare", () => {
    expect(diskAllows(hw({ diskFreeBytes: 20e9 }), 19)).toBe(false);
    expect(diskAllows(hw({ diskFreeBytes: 21e9 }), 19)).toBe(true);
    expect(diskAllows(hw({ diskFreeBytes: null }), 500)).toBe(true);
    expect(diskAllows(null, 500)).toBe(true);
  });

  it("describes the computer", () => {
    expect(describeHardware(hw())).toBe("NVIDIA GeForce RTX 4090 · 24 GB GPU memory · 64 GB RAM");
    expect(
      describeHardware(
        hw({
          unifiedMemory: true,
          ramBytes: 36 * GIB,
          accel: "unified",
          gpus: [{ name: "Apple M3 Pro GPU", vendor: "apple", vramBytes: null }],
        }),
      ),
    ).toBe("Apple M3 Pro · 36 GB shared memory");
    expect(describeHardware(hw({ gpus: [], accel: "cpu" }))).toBe("No dedicated GPU found · 64 GB RAM");
  });
});
