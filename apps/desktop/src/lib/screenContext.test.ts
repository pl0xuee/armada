import { describe, expect, it } from "vitest";
import { MAX_ORDER, MAX_SELECTION, screenContextOf } from "./screenContext";

const ui = {
  view: "agents" as const,
  selectedAgentId: "a1",
  settingsSection: "appearance",
  missionTab: "needs",
  reviewAgentId: null,
};

describe("screenContextOf", () => {
  it("reports the open agent only on the agents screen", () => {
    expect(screenContextOf(ui, null).agentId).toBe("a1");
    expect(screenContextOf({ ...ui, view: "usage" }, null).agentId).toBeNull();
  });
  it("reports the settings section or mission tab only where they apply", () => {
    const s = screenContextOf({ ...ui, view: "settings" }, null);
    expect(s.settingsSection).toBe("appearance");
    expect(s.missionTab).toBeNull();
    const m = screenContextOf({ ...ui, view: "mission" }, null);
    expect(m.missionTab).toBe("needs");
    expect(m.settingsSection).toBeNull();
  });
  it("tidies and caps the highlighted text, and drops an empty one", () => {
    expect(screenContextOf(ui, "  two\n  lines ").selectedText).toBe("two lines");
    expect(screenContextOf(ui, "   ").selectedText).toBeNull();
    expect(screenContextOf(ui, undefined).selectedText).toBeNull();
    expect(screenContextOf(ui, "x".repeat(MAX_SELECTION + 50)).selectedText).toHaveLength(MAX_SELECTION);
  });
});

describe("screenContextOf: comparison and agent order", () => {
  it("reports the open comparison only on the Compare screen", () => {
    expect(screenContextOf({ ...ui, view: "compare", compareGroupId: "g1" }, null).compareGroupId).toBe("g1");
    expect(screenContextOf({ ...ui, compareGroupId: "g1" }, null).compareGroupId).toBeNull();
    expect(screenContextOf({ ...ui, view: "compare" }, null).compareGroupId).toBeNull();
  });
  it("passes on the sidebar's order, capped", () => {
    expect(screenContextOf(ui, null).agentOrder).toEqual([]);
    expect(screenContextOf(ui, null, ["b", "a"]).agentOrder).toEqual(["b", "a"]);
    const many = Array.from({ length: MAX_ORDER + 20 }, (_, i) => `a${i}`);
    expect(screenContextOf(ui, null, many).agentOrder).toHaveLength(MAX_ORDER);
  });
});
