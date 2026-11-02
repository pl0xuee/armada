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
