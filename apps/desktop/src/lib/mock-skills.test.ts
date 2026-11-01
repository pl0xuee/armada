import { describe, expect, it } from "vitest";
import { mockSkillsList, mockSkillsSetEnabled, mockSkillsToggles } from "./mock-toolkit";

// The browser demo mirrors the backend's rules (crates/kvistcode-core/src/skill_prefs.rs).
describe("demo skill switches", () => {
  const project = "/home/sam/code/app";

  it("keeps separate lists for everywhere and for each project", () => {
    mockSkillsSetEnabled(project, "global", "user:pdf", false);
    mockSkillsSetEnabled(project, "project", "project:openapi", false);
    expect(mockSkillsToggles(project)).toEqual({ global: ["pdf"], project: ["openapi"] });
    expect(mockSkillsToggles("/home/sam/code/other")).toEqual({ global: ["pdf"], project: [] });
    expect(mockSkillsToggles(null)).toEqual({ global: ["pdf"], project: [] });

    mockSkillsSetEnabled(project, "global", "user:pdf", true);
    mockSkillsSetEnabled(project, "project", "project:openapi", true);
    expect(mockSkillsToggles(project)).toEqual({ global: [], project: [] });
  });

  it("refuses plugin skills, unknown skills, and a project switch without a project", () => {
    const plugin = mockSkillsList(project).find((s) => s.scope === "plugin")!;
    expect(() => mockSkillsSetEnabled(project, "project", plugin.id, false)).toThrow(/plugin/);
    expect(() => mockSkillsSetEnabled(project, "project", "user:ghost", false)).toThrow(/no longer exists/);
    expect(() => mockSkillsSetEnabled(null, "project", "user:pdf", false)).toThrow(/Choose a project/);
    expect(() => mockSkillsSetEnabled(project, "global", "project:openapi", false)).toThrow(/your own skills/);
    expect(mockSkillsToggles(project)).toEqual({ global: [], project: [] });
  });
});
