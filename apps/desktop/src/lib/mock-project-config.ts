// Browser-demo backend for project settings: an in-memory stand-in for the project's files.

import {
  emptyRules,
  ruleProblem,
  type ConfigEntry,
  type InstructionDoc,
  type InstructionFileName,
  type PermissionRules,
  type ProjectConfig,
  type SettingsFile,
  type SettingsScope,
} from "./projectConfig";

interface MockProject {
  instructions: Record<InstructionFileName, string | null>;
  settings: Record<SettingsScope, { rules: PermissionRules; hooks: SettingsFile["hooks"] } | null>;
  /** A settings file the demo shows as broken (invalid JSON). */
  brokenLocal?: boolean;
  commands: ConfigEntry[];
  skills: ConfigEntry[];
}

const projects = new Map<string, MockProject>();

const entry = (root: string, rel: string, name: string, description: string): ConfigEntry => ({
  name,
  description,
  path: `${root}/${rel}`,
});

function seed(root: string): MockProject {
  const first = !projects.size;
  return {
    instructions: {
      "CLAUDE.md": first
        ? "# Atlas API\n\n- Run `cargo test` before committing.\n- Handlers live in `src/routes/`; keep them thin.\n- Never edit generated files in `src/gen/`.\n"
        : null,
      "AGENTS.md": null,
    },
    settings: {
      shared: first
        ? {
            rules: {
              allow: ["Bash(cargo test:*)", "Bash(git diff:*)", "Read(./src/**)"],
              ask: ["Bash(git push:*)"],
              deny: ["Read(./.env)", "Bash(rm -rf:*)"],
            },
            hooks: [
              { event: "PreToolUse", matcher: "Bash", command: "./scripts/guard.sh", scope: "shared" },
              { event: "Stop", matcher: null, command: "cargo fmt --check", scope: "shared" },
            ],
          }
        : null,
      local: first ? { rules: { allow: ["Bash(docker compose up:*)"], ask: [], deny: [] }, hooks: [] } : null,
    },
    // The demo's "storefront" project has a hand-broken local settings file.
    brokenLocal: root.endsWith("/storefront"),
    commands: first
      ? [
          entry(root, ".claude/commands/review.md", "/review", "Review the current diff for bugs and style"),
          entry(root, ".claude/commands/db/migrate.md", "/db:migrate", "Create and run a database migration"),
        ]
      : [],
    skills: first
      ? [entry(root, ".claude/skills/openapi/SKILL.md", "openapi", "Keep the OpenAPI spec in sync with the handlers")]
      : [],
  };
}

function projectFor(project: string): MockProject {
  const key = project.trim().replace(/\/+$/, "");
  let p = projects.get(key);
  if (!p) {
    p = seed(key);
    projects.set(key, p);
  }
  return p;
}

const rootOf = (project: string) => project.trim().replace(/\/+$/, "");

function doc(root: string, p: MockProject, file: InstructionFileName): InstructionDoc {
  const content = p.instructions[file];
  return { file, path: `${root}/${file}`, exists: content !== null, content: content ?? "", error: null };
}

function settingsFile(root: string, p: MockProject, scope: SettingsScope): SettingsFile {
  const name = scope === "shared" ? "settings.json" : "settings.local.json";
  const s = p.settings[scope];
  const broken = scope === "local" && p.brokenLocal;
  return {
    scope,
    path: `${root}/.claude/${name}`,
    exists: !!s || !!broken,
    rules: s?.rules ?? emptyRules(),
    hooks: s?.hooks ?? [],
    error: broken
      ? `${name} isn't valid JSON (expected value at line 3 column 5); fix it by hand before editing rules here`
      : null,
  };
}

export function mockProjectConfig(project: string): ProjectConfig {
  const root = rootOf(project);
  if (!root || root.includes("..")) throw new Error("That folder isn't one of your projects");
  const p = projectFor(root);
  return {
    root,
    instructions: (["CLAUDE.md", "AGENTS.md"] as const).map((f) => doc(root, p, f)),
    userInstructions: {
      file: "CLAUDE.md",
      path: "/home/sam/.claude/CLAUDE.md",
      exists: true,
      content: "# Personal preferences\n\nPrefer small, focused commits. Explain trade-offs briefly.\n",
      error: null,
    },
    settings: [settingsFile(root, p, "shared"), settingsFile(root, p, "local")],
    commands: p.commands,
    skills: p.skills,
  };
}

export function mockSaveInstruction(project: string, file: InstructionFileName, content: string): InstructionDoc {
  if (file !== "CLAUDE.md" && file !== "AGENTS.md") throw new Error(`${file} isn't an editable instruction file`);
  if (content.length > 1024 * 1024) throw new Error(`${file} would be larger than 1 MiB`);
  const p = projectFor(project);
  p.instructions[file] = content;
  return doc(rootOf(project), p, file);
}

export function mockSaveRules(project: string, scope: SettingsScope, rules: PermissionRules): SettingsFile {
  const root = rootOf(project);
  const p = projectFor(project);
  if (scope === "local" && p.brokenLocal) {
    throw new Error("settings.local.json isn't valid JSON; fix it by hand before editing rules here");
  }
  const clean = emptyRules();
  for (const kind of ["allow", "ask", "deny"] as const) {
    for (const raw of rules[kind]) {
      const problem = ruleProblem(raw);
      if (problem) throw new Error(`A ${kind} rule is invalid: ${problem}`);
      if (!clean[kind].includes(raw.trim())) clean[kind].push(raw.trim());
    }
  }
  const existing = p.settings[scope];
  const empty = !clean.allow.length && !clean.ask.length && !clean.deny.length;
  // Like the backend: the file is created only when there is a rule to store.
  if (existing || !empty) p.settings[scope] = { rules: clean, hooks: existing?.hooks ?? [] };
  return settingsFile(root, p, scope);
}
