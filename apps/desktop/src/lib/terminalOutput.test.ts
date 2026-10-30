import { describe, expect, it } from "vitest";
import { stripOutputFence } from "./terminalOutput";

describe("stripOutputFence", () => {
  it("removes the fence Claude wraps around command output", () => {
    expect(stripOutputFence("```console\nhooks\n40 files\n```")).toBe("hooks\n40 files");
    expect(stripOutputFence("```\nok\n```\n")).toBe("ok");
    expect(stripOutputFence("```console\n\n```")).toBe("");
  });

  it("handles output that is still arriving", () => {
    expect(stripOutputFence("```console")).toBe("");
    expect(stripOutputFence("```console\nline 1\nline 2")).toBe("line 1\nline 2");
  });

  it("leaves other output alone", () => {
    expect(stripOutputFence("plain output")).toBe("plain output");
    // A fence that isn't wrapping anything stays: it may be real output.
    expect(stripOutputFence("the file ends with a fence\n```")).toBe("the file ends with a fence\n```");
    // The start was cut off of a long output: the closing fence still goes.
    expect(stripOutputFence("…tail of output\n```", true)).toBe("…tail of output");
  });

  it("keeps fences inside the output", () => {
    expect(stripOutputFence("```console\nbefore\n```js\ncode\n```\nafter\n```")).toBe("before\n```js\ncode\n```\nafter");
  });
});
