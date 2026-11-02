import { describe, expect, it } from "vitest";
import { applyNavigation } from "./voiceAssistant";
import { useUi } from "./ui";

describe("assistant navigation", () => {
  it("opens each screen it can name", () => {
    for (const view of ["usage", "schedules", "accounts", "settings", "compare"] as const) {
      applyNavigation(view, null);
      expect(useUi.getState().view).toBe(view);
    }
  });
  it("keeps the older targets working", () => {
    applyNavigation("mission_control", null);
    expect(useUi.getState().view).toBe("mission");
    applyNavigation("agents", null);
    expect(useUi.getState().view).toBe("agents");
  });
});

describe("assistant navigation to a section", () => {
  it("opens a settings section, and ignores one it doesn't know", () => {
    applyNavigation("settings", null, "budgets");
    expect(useUi.getState().view).toBe("settings");
    expect(useUi.getState().settingsSection).toBe("budgets");
    applyNavigation("settings", null, "bogus");
    expect(useUi.getState().settingsSection).toBe("budgets");
  });
  it("opens Mission Control on the tab asked for", () => {
    applyNavigation("mission_control", null, "all");
    expect(useUi.getState().view).toBe("mission");
    expect(useUi.getState().missionTab).toBe("all");
    applyNavigation("inbox", null);
    expect(useUi.getState().missionTab).toBe("needs");
  });
});

describe("assistant navigation to an agent's comparison", () => {
  it("opens the comparison the agent belongs to, or the Compare screen when it has none", async () => {
    const { useApp } = await import("./app");
    const base = useApp.getState().agents;
    useApp.setState({
      agents: {
        ...base,
        c1: { groupId: "grp-1" } as never,
        c2: { groupId: null } as never,
      },
    });
    applyNavigation("compare", "c1");
    expect(useUi.getState().view).toBe("compare");
    expect(useUi.getState().compareGroupId).toBe("grp-1");
    applyNavigation("compare", "c2");
    expect(useUi.getState().view).toBe("compare");
    useApp.setState({ agents: base });
  });
  it("opens a named agent on the Agents screen (also what opening a project does)", () => {
    applyNavigation("usage", null);
    applyNavigation("agents", "a9");
    expect(useUi.getState().view).toBe("agents");
    expect(useUi.getState().selectedAgentId).toBe("a9");
  });
});
