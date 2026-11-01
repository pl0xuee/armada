import { describe, expect, it } from "vitest";
import {
  NO_TOGGLES,
  offNote,
  offScope,
  onScopes,
  restartNote,
  runningAgents,
  skillKey,
  skillSwitch,
  type SkillInfo,
} from "./toolkit";

const skill = (scope: SkillInfo["scope"], dir: string, plugin: string | null = null): SkillInfo => ({
  id: plugin ? `plugin:${plugin}/${dir}` : `${scope}:${dir}`,
  name: dir,
  description: "",
  scope,
  plugin,
  path: `/x/${dir}/SKILL.md`,
  readOnly: scope === "plugin",
});

describe("skillKey", () => {
  it("is the folder name for your skills and the project's, and none for plugins'", () => {
    expect(skillKey(skill("user", "pdf"))).toBe("pdf");
    expect(skillKey(skill("project", "deploy"))).toBe("deploy");
    expect(skillKey(skill("plugin", "lint", "tools"))).toBeNull();
    expect(skillKey({ id: "garbage", scope: "user" })).toBeNull();
  });
});

describe("skillSwitch", () => {
  const pdf = skill("user", "pdf");
  const deploy = skill("project", "deploy");

  it("is on when nothing is switched off", () => {
    expect(skillSwitch(pdf, NO_TOGGLES)).toEqual({ on: true, offGlobal: false, offProject: false, managedBy: null });
  });

  it("is off when either list holds it", () => {
    expect(skillSwitch(pdf, { global: ["pdf"], project: [] })).toMatchObject({ on: false, offGlobal: true });
    expect(skillSwitch(pdf, { global: [], project: ["pdf"] })).toMatchObject({ on: false, offProject: true });
  });

  it("ignores the global list for a project's own skill", () => {
    expect(skillSwitch(deploy, { global: ["deploy"], project: [] }).on).toBe(true);
    expect(skillSwitch(deploy, { global: [], project: ["deploy"] }).on).toBe(false);
  });

  it("leaves plugin skills to the plugin", () => {
    const sw = skillSwitch(skill("plugin", "lint", "reviewer"), { global: ["lint"], project: ["lint"] });
    expect(sw).toMatchObject({ on: true, managedBy: "reviewer" });
  });
});

describe("where a switch goes", () => {
  it("sends a project skill to its project, yours to the choice, and everything global without a project", () => {
    const user = skill("user", "pdf");
    expect(offScope(skill("project", "deploy"), "global", "/p")).toBe("project");
    expect(offScope(user, "global", "/p")).toBe("global");
    expect(offScope(user, "project", "/p")).toBe("project");
    expect(offScope(user, "project", null)).toBe("global");
  });

  it("switching on clears everywhere it is off", () => {
    const pdf = skill("user", "pdf");
    expect(onScopes(skillSwitch(pdf, { global: ["pdf"], project: ["pdf"] }))).toEqual(["global", "project"]);
    expect(onScopes(skillSwitch(pdf, { global: [], project: ["pdf"] }))).toEqual(["project"]);
    expect(onScopes(skillSwitch(pdf, NO_TOGGLES))).toEqual([]);
  });
});

describe("offNote", () => {
  const pdf = skill("user", "pdf");
  it("says where a skill is off, and nothing while it is on", () => {
    expect(offNote(skillSwitch(pdf, NO_TOGGLES), "app")).toBeNull();
    expect(offNote(skillSwitch(pdf, { global: ["pdf"], project: [] }), "app")).toBe("Off in every project");
    expect(offNote(skillSwitch(pdf, { global: [], project: ["pdf"] }), "app")).toBe("Off in app");
    expect(offNote(skillSwitch(pdf, { global: ["pdf"], project: ["pdf"] }), "app")).toBe(
      "Off in every project and in app",
    );
    expect(offNote(skillSwitch(skill("plugin", "x", "p"), NO_TOGGLES), "app")).toBeNull();
  });
});

describe("running agents", () => {
  const a = (status: string, provider: string, projectPath: string) =>
    ({ status, provider, projectPath }) as Parameters<typeof runningAgents>[0][number];
  const list = [
    a("working", "claude", "/work/app"),
    a("idle", "claude", "/work/app/"),
    a("idle", "codex", "/work/app"),
    a("stopped", "claude", "/work/app"),
    a("interrupted", "claude", "/work/app"),
    a("idle", "claude", "/work/other"),
  ];

  it("counts only agents that already started", () => {
    expect(runningAgents(list)).toBe(4);
  });

  it("narrows by provider and project", () => {
    expect(runningAgents(list, { provider: "claude" })).toBe(3);
    expect(runningAgents(list, { provider: "claude", project: "/work/app" })).toBe(2);
    expect(runningAgents(list, { project: "/work/app" })).toBe(3);
  });

  it("words the restart hint, and stays quiet when nobody is affected", () => {
    expect(restartNote(0)).toBeNull();
    expect(restartNote(1)).toBe("1 agent is running now; restart it to pick this up.");
    expect(restartNote(3)).toBe("3 agents are running now; restart them to pick this up.");
  });
});
