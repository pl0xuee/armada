import { describe, expect, it } from "vitest";
import { fenced } from "./xterm-theme";

describe("fenced", () => {
  it("wraps text in a fence", () => {
    expect(fenced("ls\nfoo")).toBe("```\nls\nfoo\n```");
  });
  it("uses a longer fence than any backtick run inside", () => {
    expect(fenced("a ```b``` c")).toBe("````\na ```b``` c\n````");
  });
});
