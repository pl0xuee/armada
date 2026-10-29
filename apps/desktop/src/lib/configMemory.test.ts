import { describe, expect, it } from "vitest";
import { configDefaultsKey, isRememberableOption, rememberedGroups } from "./configMemory";
import type { ConfigOption } from "./types";

const opt = (id: string, values: string[], category: string | null = null): ConfigOption => ({
  id,
  name: id,
  category,
  currentValue: values[0],
  options: values.map((value) => ({ value, name: value, description: null })),
});

describe("isRememberableOption", () => {
  it("never remembers permission-style options", () => {
    expect(isRememberableOption(opt("mode", ["ask", "auto"]))).toBe(false);
    expect(isRememberableOption(opt("approval", ["untrusted", "never"], "mode"))).toBe(false);
    expect(isRememberableOption(opt("x", ["a", "bypassPermissions"]))).toBe(false);
    expect(isRememberableOption(opt("sandbox", ["workspace-write"]))).toBe(false);
  });
  it("rejects disguised permission options", () => {
    expect(isRememberableOption(opt("access", ["a", "full-access"]))).toBe(false);
    expect(isRememberableOption(opt("tool_permission_level", ["a", "b"]))).toBe(false);
    expect(isRememberableOption(opt("x", ["a", "acceptEdits"]))).toBe(false);
  });
  it("remembers model and effort", () => {
    expect(isRememberableOption(opt("model", ["opus", "sonnet"], "model"))).toBe(true);
    expect(isRememberableOption(opt("effort", ["low", "high"]))).toBe(true);
  });
});

describe("rememberedGroups", () => {
  it("names providers and drops empty groups", () => {
    const g = rememberedGroups({ claude: { model: "opus", effort: "high" }, codex: {} }, []);
    expect(g).toHaveLength(1);
    expect(g[0].entries.map((e) => e.id)).toEqual(["effort", "model"]);
  });
  it("keys custom agents separately", () => {
    expect(configDefaultsKey("custom", "abc")).toBe("custom:abc");
    expect(configDefaultsKey("claude", null)).toBe("claude");
  });
});
