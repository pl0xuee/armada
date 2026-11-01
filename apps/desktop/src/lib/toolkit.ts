// "Tools & instructions": project instruction files, MCP servers and skills in one place.
// Types mirror crates/kvistcode-core/src/{project_config,skills}.rs; the helpers are pure.

import type { InstructionDoc, InstructionFileName } from "./projectConfig";
import type { McpServer, Provider } from "./types";

export type ToolkitTab = "instructions" | "mcp" | "skills";

// ---------------------------------------------------------------- instructions

/** Result of a checked save: `saved` is false when the file changed on disk meanwhile (nothing was written). */
export interface InstructionSave {
  saved: boolean;
  doc: InstructionDoc;
}

export interface InstructionInfo {
  /** Who reads the file. */
  readers: string[];
  blurb: string;
  /** Provider the "draft it for me" agent starts on. */
  starter: Provider;
}

export const INSTRUCTION_INFO: Record<InstructionFileName, InstructionInfo> = {
  "CLAUDE.md": {
    readers: ["Claude"],
    blurb: "Claude Code reads this at the start of every session in the project.",
    starter: "claude",
  },
  "AGENTS.md": {
    readers: ["Codex", "Grok", "Others"],
    blurb: "Codex, Grok and other agents that follow the AGENTS.md convention read this.",
    starter: "codex",
  },
};

/** What to do about a file's state on disk compared to what the editor loaded. */
export type DiskCheck = "same" | "reload" | "conflict";

/**
 * `same`: nothing changed. `reload`: it changed and there is nothing of yours to lose (or the
 * disk already holds your text). `conflict`: it changed while you have unsaved edits.
 */
export function checkDisk(args: {
  dirty: boolean;
  loadedStamp: string | null | undefined;
  disk: InstructionDoc;
  text: string;
}): DiskCheck {
  if ((args.disk.stamp ?? null) === (args.loadedStamp ?? null)) return "same";
  if (!args.dirty || args.disk.content === args.text) return "reload";
  return "conflict";
}

/** Prompt for the agent that drafts an instruction file. */
export function starterPrompt(file: InstructionFileName): string {
  return (
    `Look through this project (its README, build files, scripts, tests and source layout) and write a ${file} at the project root for coding agents.\n\n` +
    "Keep it short and specific: how to build, test and lint; the folder layout; conventions that aren't obvious from the code; and things to avoid. " +
    "Don't invent commands you haven't confirmed exist. " +
    `Write the file when you're done and tell me what you put in it.`
  );
}

// ---------------------------------------------------------------- MCP scope

export const normProject = (p: string) => p.trim().replace(/[\\/]+$/, "");

export const isProjectServer = (s: McpServer) => !!s.projectPath?.trim();

export interface ScopedServers {
  /** Servers only this project gets. */
  project: McpServer[];
  /** Servers every project gets. */
  global: McpServer[];
  /** Ids of global servers a same-named project server replaces for this project. */
  shadowed: Set<string>;
  /** Servers that belong to other projects (not listed). */
  elsewhere: number;
}

/** Splits the saved servers into what `project` sees. Without a project only the global ones show. */
export function scopeServers(servers: McpServer[], project: string | null): ScopedServers {
  const want = project ? normProject(project) : null;
  const mine = servers.filter((s) => isProjectServer(s) && want !== null && normProject(s.projectPath ?? "") === want);
  const global = servers.filter((s) => !isProjectServer(s));
  const names = new Set(mine.map((s) => s.name.trim().toLowerCase()));
  return {
    project: mine,
    global,
    shadowed: new Set(global.filter((s) => names.has(s.name.trim().toLowerCase())).map((s) => s.id)),
    elsewhere: servers.length - mine.length - global.length,
  };
}

const MCP_AGENTS = ["Claude", "Codex", "Grok", "Local models", "Custom agents"];

/** Which agents start with this server, and a caveat when one applies. */
export function mcpPickup(server: McpServer, shadowed = false): { agents: string[]; note: string | null } {
  if (!server.enabled) return { agents: [], note: "Switched off: no agent gets it." };
  if (shadowed) return { agents: [], note: "Replaced in this project by a server with the same name." };
  return {
    agents: MCP_AGENTS,
    note: server.transport === "http" ? "Custom agents need HTTP support." : null,
  };
}

/** "all agents", or the names when it is a subset. */
export function pickupSummary(agents: string[]): string {
  if (agents.length === 0) return "no agents";
  if (agents.length === MCP_AGENTS.length) return "all agents";
  return agents.join(" · ");
}

// ---------------------------------------------------------------- skills

export type SkillScope = "user" | "project" | "plugin";

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  scope: SkillScope;
  plugin: string | null;
  path: string;
  readOnly: boolean;
}

export interface SkillDoc extends SkillInfo {
  content: string;
  truncated: boolean;
  files: string[];
}

export const MAX_SKILL_NAME = 64;

/** Why `name` can't be a skill folder name (the backend enforces the same), or null. */
export function skillNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return "Give the skill a name";
  if (n.length > MAX_SKILL_NAME) return `At most ${MAX_SKILL_NAME} characters`;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n)) return "Use lowercase letters, digits and hyphens, like code-review";
  return null;
}

/** "Code Review!" becomes "code-review". */
export function slugifySkill(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SKILL_NAME)
    .replace(/-+$/, "");
}

export const SKILL_SCOPE_LABEL: Record<SkillScope, string> = {
  user: "Yours",
  project: "This project",
  plugin: "Plugins",
};

/** Skills grouped for display: project, yours, then plugins; empty groups dropped. */
export function groupSkills(skills: SkillInfo[]): { scope: SkillScope; skills: SkillInfo[] }[] {
  return (["project", "user", "plugin"] as const)
    .map((scope) => ({ scope, skills: skills.filter((s) => s.scope === scope) }))
    .filter((g) => g.skills.length > 0);
}
