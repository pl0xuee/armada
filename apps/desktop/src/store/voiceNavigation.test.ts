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
