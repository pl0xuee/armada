import { describe, expect, it } from "vitest";
import {
  LruCache,
  STREAMING_HIGHLIGHT_LINES,
  highlight,
  headLines,
  canHighlight,
  hunkSides,
  langFromFence,
  langFromPath,
  mapDiffTokens,
  mergeStale,
  type HlLine,
} from "./highlight";

describe("langFromFence", () => {
  it("normalises tags and aliases", () => {
    expect(langFromFence("ts")).toBe("typescript");
    expect(langFromFence("TSX")).toBe("tsx");
    expect(langFromFence("bash")).toBe("shellscript");
    expect(langFromFence("language-rust")).toBe("rust");
    expect(langFromFence("python title=x")).toBe("python");
    expect(langFromFence("c++")).toBe("cpp");
  });
  it("returns null for unknown or empty", () => {
    expect(langFromFence("brainfuck")).toBeNull();
    expect(langFromFence("text")).toBeNull();
    expect(langFromFence(null)).toBeNull();
    expect(langFromFence("")).toBeNull();
  });
});

describe("langFromPath", () => {
  it("uses the extension", () => {
    expect(langFromPath("src/App.tsx")).toBe("tsx");
    expect(langFromPath("a/b/main.rs")).toBe("rust");
    expect(langFromPath("C:\\x\\script.PY")).toBe("python");
    expect(langFromPath("Cargo.lock")).toBe("toml");
  });
  it("handles special names and unknowns", () => {
    expect(langFromPath("docker/Dockerfile")).toBe("dockerfile");
    expect(langFromPath("README")).toBeNull();
    expect(langFromPath("image.png")).toBeNull();
    expect(langFromPath(null)).toBeNull();
  });
});

describe("canHighlight", () => {
  it("caps size and line count", () => {
    expect(canHighlight("a\nb")).toBe(true);
    expect(canHighlight("x".repeat(200_001))).toBe(false);
    expect(canHighlight("\n".repeat(4_999))).toBe(true);
    expect(canHighlight("\n".repeat(5_000))).toBe(false);
  });
});

describe("LruCache", () => {
  it("evicts least recently used by entry count", () => {
    const c = new LruCache<number>(2, 100);
    c.set("a", 1);
    c.set("b", 2);
    c.get("a");
    c.set("c", 3);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(1);
    expect(c.get("c")).toBe(3);
  });
  it("evicts by total size but keeps the newest entry", () => {
    const c = new LruCache<number>(10, 10);
    c.set("a", 1, 6);
    c.set("b", 2, 6);
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe(2);
    c.set("huge", 3, 50);
    expect(c.size).toBe(1);
  });
});

describe("diff token mapping", () => {
  const lines = [
    { type: "context" as const, text: "a" },
    { type: "del" as const, text: "b" },
    { type: "add" as const, text: "B" },
    { type: "add" as const, text: "C" },
    { type: "context" as const, text: "d" },
  ];
  const tok = (t: string): HlLine => [{ t }];
  it("splits a hunk into old and new text", () => {
    expect(hunkSides(lines)).toEqual({ oldText: "a\nb\nd", newText: "a\nB\nC\nd" });
  });
  it("maps deletions to the old side and the rest to the new side", () => {
    const old = ["a", "b", "d"].map((t) => tok("o" + t));
    const nw = ["a", "B", "C", "d"].map((t) => tok("n" + t));
    const mapped = mapDiffTokens(lines, old, nw).map((l) => l?.[0].t);
    expect(mapped).toEqual(["na", "ob", "nB", "nC", "nd"]);
  });
  it("falls back to the other side or null", () => {
    const old = ["a", "b", "d"].map((t) => tok("o" + t));
    expect(mapDiffTokens(lines, old, null).map((l) => l?.[0].t ?? null)).toEqual(["oa", "ob", null, null, "od"]);
    expect(mapDiffTokens(lines, null, null)).toEqual([null, null, null, null, null]);
  });
});

describe("mergeStale", () => {
  it("keeps tokens for unchanged lines and renders the rest plain", () => {
    const prev: HlLine[] = [[{ t: "let", c: "var(--syntax-token-keyword)" }, { t: " x" }], [{ t: "y" }]];
    const out = mergeStale(prev, "let x\nyy\n");
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toEqual([{ t: "yy" }]);
    expect(out[2]).toEqual([]);
  });
  it("works without a previous result", () => {
    expect(mergeStale(null, "a\nb")).toEqual([[{ t: "a" }], [{ t: "b" }]]);
  });
});

describe("streaming caps", () => {
  const block = (n: number) =>
    Array.from({ length: n }, (_, i) => `export const v${i}: number = ${i}; // line ${i}`).join("\n");

  it("headLines keeps the first n lines", () => {
    expect(headLines("a\nb\nc", 2)).toBe("a\nb");
    expect(headLines("a\nb", 5)).toBe("a\nb");
    expect(headLines("a\nb\n", 2)).toBe("a\nb");
  });

  it("highlights only the leading lines in streaming mode, everything otherwise", async () => {
    const code = block(4000);
    await highlight("typescript", "x"); // load Shiki + grammar outside the timing
    const t0 = performance.now();
    const part = await highlight("typescript", code, { maxLines: STREAMING_HIGHLIGHT_LINES });
    const tPart = performance.now() - t0;
    expect(part).toHaveLength(STREAMING_HIGHLIGHT_LINES);
    const t1 = performance.now();
    const full = await highlight("typescript", code);
    const tFull = performance.now() - t1;
    expect(full).toHaveLength(4000);
    console.log(`4k-line TS block: streaming ${tPart.toFixed(0)} ms, full ${tFull.toFixed(0)} ms`);
    // The shared prefix tokenizes identically.
    expect(part![10]).toEqual(full![10]);
  }, 60_000);

  it("keeps the 5000-line cap for finished blocks", async () => {
    expect(await highlight("typescript", block(5001))).toBeNull();
    expect(await highlight("typescript", block(5001), { maxLines: 10 })).toHaveLength(10);
  }, 60_000);
});
