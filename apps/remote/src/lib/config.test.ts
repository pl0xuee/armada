import { describe, expect, it } from "vitest";
import { applyConfigValue, choiceName, visibleOptions } from "./config";
import { formatDuration } from "./format";
import type { ConfigOption } from "./types";

const codexApprovals: ConfigOption = {
  id: "approval_preset",
  name: "Approvals",
  category: "mode",
  currentValue: "auto",
  options: [
    { value: "read-only", name: "Read only", description: null },
    { value: "auto", name: "Auto", description: null },
  ],
};

describe("config options", () => {
  it("shows the current choice by name and falls back to the raw value", () => {
    expect(choiceName(codexApprovals)).toBe("Auto");
    expect(choiceName({ ...codexApprovals, currentValue: "custom-x" })).toBe("custom-x");
  });
  it("applies a value to just that option (any provider's ids)", () => {
    const next = applyConfigValue([codexApprovals, { ...codexApprovals, id: "model" }], "approval_preset", "read-only");
    expect(next.map((o) => o.currentValue)).toEqual(["read-only", "auto"]);
  });
  it("hides options without choices", () => {
    expect(visibleOptions([codexApprovals, { ...codexApprovals, id: "empty", options: [] }]).map((o) => o.id)).toEqual(["approval_preset"]);
    expect(visibleOptions(undefined)).toEqual([]);
  });
});

describe("formatDuration", () => {
  it("formats compactly", () => {
    expect(formatDuration(400)).toBe("1s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(252_000)).toBe("4m 12s");
    expect(formatDuration(3_900_000)).toBe("1h 5m");
    expect(formatDuration(-1)).toBe("");
  });
});
