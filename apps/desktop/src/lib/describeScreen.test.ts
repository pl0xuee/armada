import { describe, expect, it } from "vitest";
import { describeScreen, MAX_SEEN_TITLE } from "./describeScreen";

const agents = {
  a1: { title: "KvistCode", projectPath: "/home/me/Projects/Kvistcode/" },
  a2: { title: "Other", projectPath: "C:\\work\\site" },
  a3: { title: "x".repeat(80), projectPath: "/p/y" },
  a4: { title: "No folder", projectPath: "" },
};

describe("describeScreen", () => {
  it("names the open agent and its folder", () => {
    const d = describeScreen({ view: "agents", agentId: "a1" }, agents);
    expect(d.label).toBe("KvistCode · Kvistcode");
    expect(d.full).toBe("KvistCode · Kvistcode");
    expect(d.together).toBeNull();
  });

  it("reads a Windows folder too, and skips an empty one", () => {
    expect(describeScreen({ view: "agents", agentId: "a2" }, agents).label).toBe("Other · site");
    expect(describeScreen({ view: "agents", agentId: "a4" }, agents).label).toBe("No folder");
  });

  it("names the screen when no agent is open", () => {
    expect(describeScreen({ view: "agents", agentId: null }, agents).label).toBe("Agents");
  });

  it("names other screens, ignoring an agent id that is not shown there", () => {
    expect(describeScreen({ view: "mission", agentId: null }, agents).label).toBe("Mission Control");
    expect(describeScreen({ view: "usage", agentId: null }, agents).label).toBe("Usage");
    expect(describeScreen({ view: "settings", agentId: "a1" }, agents).label).toBe("Settings");
  });

  it("counts the other agents shown side by side", () => {
    const d = describeScreen({ view: "agents", agentId: "a1" }, agents, ["a1", "a2", "a3"]);
    expect(d.together).toBe("+2 side by side");
    expect(describeScreen({ view: "agents", agentId: "a1" }, agents, ["a1"]).together).toBeNull();
    expect(describeScreen({ view: "agents", agentId: "a1" }, agents, null).together).toBeNull();
  });

  it("cuts long titles but keeps the full text for the tooltip", () => {
    const d = describeScreen({ view: "agents", agentId: "a3" }, agents);
    expect(d.label.startsWith("x".repeat(MAX_SEEN_TITLE - 1))).toBe(true);
    expect(d.label).toContain("…");
    expect(d.label.length).toBeLessThan(80);
    expect(d.full).toBe(`${"x".repeat(80)} · y`);
  });

  it("says so when the open agent is missing", () => {
    const d = describeScreen({ view: "agents", agentId: "gone" }, agents, ["gone", "a1"]);
    expect(d.label).toBe("an agent that is gone");
    expect(d.together).toBeNull();
  });
});

describe("describeScreen with a count", () => {
  it("takes how many agents are shown, the open one included", () => {
    expect(describeScreen({ view: "agents", agentId: "a1" }, agents, 3).together).toBe("+2 side by side");
    expect(describeScreen({ view: "agents", agentId: "a1" }, agents, 1).together).toBeNull();
    expect(describeScreen({ view: "agents", agentId: "a1" }, agents, 0).together).toBeNull();
  });
});
