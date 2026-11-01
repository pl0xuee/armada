import { beforeEach, describe, expect, it } from "vitest";
import { openToolkit, useToolkit } from "./toolkit";
import { useProjectSettings } from "./projectSettings";
import { useUi } from "./ui";

describe("openToolkit", () => {
  beforeEach(() => {
    useToolkit.setState({ tab: "instructions" });
    useProjectSettings.setState({ project: null });
    useUi.setState({ view: "agents" });
  });

  it("opens Settings on the toolkit section, tab and project", () => {
    openToolkit("skills", "/work/app");
    expect(useUi.getState().view).toBe("settings");
    expect(useUi.getState().settingsSection).toBe("toolkit");
    expect(useToolkit.getState().tab).toBe("skills");
    expect(useProjectSettings.getState().project).toBe("/work/app");
  });

  it("keeps the current tab and project when none is given", () => {
    useToolkit.setState({ tab: "mcp" });
    useProjectSettings.setState({ project: "/work/keep" });
    openToolkit();
    expect(useToolkit.getState().tab).toBe("mcp");
    expect(useProjectSettings.getState().project).toBe("/work/keep");
  });
});
