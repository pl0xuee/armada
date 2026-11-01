import { describe, expect, it } from "vitest";
import type { InstructionDoc } from "./projectConfig";
import {
  checkDisk,
  groupSkills,
  mcpPickup,
  pickupSummary,
  scopeServers,
  skillNameProblem,
  slugifySkill,
  starterPrompt,
  type SkillInfo,
} from "./toolkit";
import type { McpServer } from "./types";

const server = (id: string, name: string, extra: Partial<McpServer> = {}): McpServer => ({
  id,
  name,
  enabled: true,
  transport: "stdio",
  command: "npx",
  args: [],
  env: [],
  url: "",
  headers: [],
  ...extra,
});

const disk = (content: string, stamp: string | null): InstructionDoc => ({
  file: "CLAUDE.md",
  path: "/p/CLAUDE.md",
  exists: stamp !== null,
  content,
  error: null,
  stamp,
});

describe("checkDisk", () => {
  it("is quiet while the stamp matches", () => {
    expect(checkDisk({ dirty: true, loadedStamp: "1", disk: disk("a", "1"), text: "b" })).toBe("same");
    expect(checkDisk({ dirty: false, loadedStamp: null, disk: disk("", null), text: "" })).toBe("same");
  });
  it("reloads silently when there are no unsaved edits", () => {
    expect(checkDisk({ dirty: false, loadedStamp: "1", disk: disk("new", "2"), text: "old" })).toBe("reload");
  });
  it("flags a conflict only when unsaved text differs from what is on disk", () => {
    expect(checkDisk({ dirty: true, loadedStamp: "1", disk: disk("theirs", "2"), text: "mine" })).toBe("conflict");
    expect(checkDisk({ dirty: true, loadedStamp: "1", disk: disk("same", "2"), text: "same" })).toBe("reload");
  });
  it("notices a file that appeared or vanished", () => {
    expect(checkDisk({ dirty: true, loadedStamp: null, disk: disk("x", "5"), text: "mine" })).toBe("conflict");
    expect(checkDisk({ dirty: false, loadedStamp: "5", disk: disk("", null), text: "x" })).toBe("reload");
  });
  it("treats a missing stamp like no file", () => {
    const d = { ...disk("", null), stamp: undefined };
    expect(checkDisk({ dirty: false, loadedStamp: undefined, disk: d, text: "" })).toBe("same");
  });
});

describe("scopeServers", () => {
  const all = [
    server("g", "GitHub"),
    server("a", "DB", { projectPath: "/work/app" }),
    server("b", "Other", { projectPath: "/work/other/" }),
    server("g2", "db"),
  ];
  it("splits global from project servers and ignores other projects", () => {
    const s = scopeServers(all, "/work/app/");
    expect(s.project.map((x) => x.id)).toEqual(["a"]);
    expect(s.global.map((x) => x.id)).toEqual(["g", "g2"]);
    expect(s.elsewhere).toBe(1);
  });
  it("marks globals a same-named project server replaces", () => {
    expect([...scopeServers(all, "/work/app").shadowed]).toEqual(["g2"]);
    expect(scopeServers(all, "/work/other").shadowed.size).toBe(0);
  });
  it("shows only global servers without a project", () => {
    const s = scopeServers(all, null);
    expect(s.project).toEqual([]);
    expect(s.elsewhere).toBe(2);
  });
  it("treats a blank projectPath as global", () => {
    expect(scopeServers([server("x", "X", { projectPath: "  " })], "/p").global).toHaveLength(1);
  });
});

describe("mcpPickup", () => {
  it("reaches every provider when on", () => {
    const p = mcpPickup(server("a", "A"));
    expect(pickupSummary(p.agents)).toBe("all agents");
    expect(p.note).toBeNull();
  });
  it("explains why nothing picks a server up", () => {
    expect(mcpPickup(server("a", "A", { enabled: false })).agents).toEqual([]);
    expect(mcpPickup(server("a", "A"), true).note).toMatch(/Replaced/);
    expect(pickupSummary([])).toBe("no agents");
  });
  it("warns about HTTP support for custom agents", () => {
    expect(mcpPickup(server("a", "A", { transport: "http" })).note).toMatch(/Custom agents/);
  });
});

describe("skill names", () => {
  it("accepts folder-style names", () => {
    expect(skillNameProblem("code-review")).toBeNull();
    expect(skillNameProblem("pdf2")).toBeNull();
  });
  it("rejects anything that could escape or look odd", () => {
    for (const bad of ["", " ", "../x", "a/b", "A", "-a", "a-", "a--b", ".a", "a b", "x".repeat(65)]) {
      expect(skillNameProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
  });
  it("slugifies titles into valid names", () => {
    expect(slugifySkill("Code Review!")).toBe("code-review");
    expect(slugifySkill("  ../etc/passwd ")).toBe("etc-passwd");
    expect(skillNameProblem(slugifySkill("Release  notes — v2"))).toBeNull();
    expect(slugifySkill("!!!")).toBe("");
  });
});

describe("groupSkills", () => {
  const s = (id: string, scope: SkillInfo["scope"]): SkillInfo => ({
    id,
    name: id,
    description: "",
    scope,
    plugin: null,
    path: "/x",
    readOnly: scope === "plugin",
  });
  it("orders project, yours, plugins and drops empty groups", () => {
    const groups = groupSkills([s("p", "plugin"), s("u", "user"), s("q", "user")]);
    expect(groups.map((g) => [g.scope, g.skills.length])).toEqual([
      ["user", 2],
      ["plugin", 1],
    ]);
  });
});

describe("starterPrompt", () => {
  it("names the file", () => {
    expect(starterPrompt("AGENTS.md")).toContain("AGENTS.md");
  });
});
