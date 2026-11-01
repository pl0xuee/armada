// Browser-demo backend for "Tools & instructions": checked instruction saves and an
// in-memory set of skills.

import type { InstructionFileName } from "./projectConfig";
import { mockExternalEdit, mockReadInstruction, mockSaveInstruction } from "./mock-project-config";
import { skillNameProblem, type InstructionSave, type SkillDoc, type SkillInfo } from "./toolkit";

const HOME = "/home/sam";

const seedSkills = (project: string | null): SkillInfo[] => {
  const mk = (
    scope: SkillInfo["scope"],
    dir: string,
    description: string,
    plugin: string | null = null,
    name = dir,
  ): SkillInfo => ({
    id: plugin ? `plugin:${plugin}/${dir}` : `${scope}:${dir}`,
    name,
    description,
    scope,
    plugin,
    path:
      scope === "project"
        ? `${project}/.claude/skills/${dir}/SKILL.md`
        : scope === "user"
          ? `${HOME}/.claude/skills/${dir}/SKILL.md`
          : `${HOME}/.claude/plugins/cache/${plugin}/skills/${dir}/SKILL.md`,
    readOnly: scope === "plugin",
  });
  return [
    ...(project ? [mk("project", "openapi", "Keep the OpenAPI spec in sync with the handlers")] : []),
    mk("user", "pdf", "Read, merge and fill in PDF files. Use when the user mentions a PDF or a form."),
    mk("user", "release-notes", "Draft user-facing release notes from the commits since the last tag"),
    mk("plugin", "frontend-design", "Create distinctive, production-grade interfaces", "frontend"),
    mk("plugin", "code-review", "Review a pull request for bugs and style", "reviewer"),
  ];
};

const created: SkillInfo[] = [];
const bodies = new Map<string, string>();

const skillBody = (s: SkillInfo) =>
  bodies.get(s.id) ??
  `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n# ${s.name}\n\n## When to use\n\n${s.description.replace(/\.$/, "")}.\n\n## Steps\n\n1. Read the request and the files involved.\n2. Do the work in small, checkable steps.\n3. Report what changed.\n`;

const all = (project: string | null) => {
  const base = seedSkills(project);
  return [...created.filter((s) => s.scope === "user" || project !== null), ...base]
    .filter((s, i, list) => list.findIndex((x) => x.id === s.id) === i)
    .sort((a, b) => ["project", "user", "plugin"].indexOf(a.scope) - ["project", "user", "plugin"].indexOf(b.scope));
};

export function mockSkillsList(project: string | null): SkillInfo[] {
  return all(project);
}

export function mockSkillsRead(project: string | null, id: string): SkillDoc {
  const s = all(project).find((x) => x.id === id);
  if (!s) throw new Error("That skill no longer exists");
  return {
    ...s,
    content: skillBody(s),
    truncated: false,
    files: s.id === "user:pdf" ? ["scripts/", "reference.md"] : [],
  };
}

export function mockSkillsCreate(
  project: string | null,
  scope: "user" | "project",
  name: string,
  description: string,
): SkillInfo {
  const bad = skillNameProblem(name);
  if (bad) throw new Error(bad);
  if (scope === "project" && !project) throw new Error("Choose a project for this skill");
  const id = `${scope}:${name.trim()}`;
  if (all(project).some((s) => s.id === id)) throw new Error(`A skill named ${name.trim()} already exists`);
  const desc = description.trim() || "Describe what this skill does and when Claude should use it.";
  const info: SkillInfo = {
    id,
    name: name.trim(),
    description: desc,
    scope,
    plugin: null,
    path:
      scope === "project" ? `${project}/.claude/skills/${name}/SKILL.md` : `${HOME}/.claude/skills/${name}/SKILL.md`,
    readOnly: false,
  };
  created.push(info);
  const title = name
    .trim()
    .replace(/-/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
  bodies.set(
    id,
    `---\nname: ${info.name}\ndescription: >\n  ${desc}\n---\n\n# ${title}\n\n## When to use\n\nSay when this skill applies. Claude reads the description above to decide.\n\n## Steps\n\n1. First step.\n2. Second step.\n\n## Notes\n\nAnything Claude should avoid, or where to find supporting files in this folder.\n`,
  );
  return info;
}

export function mockInstructionsSave(
  project: string,
  file: InstructionFileName,
  content: string,
  expectedStamp: string | null,
  force: boolean,
): InstructionSave {
  const current = mockReadInstruction(project, file);
  if (!force && (current.stamp ?? null) !== expectedStamp) return { saved: false, doc: current };
  return { saved: true, doc: mockSaveInstruction(project, file, content) };
}

export { mockReadInstruction };

// Demo only: lets the browser demo (and screenshots) edit an instruction file "in another editor".
if (typeof window !== "undefined") {
  (window as unknown as { __armadaExternalEdit?: typeof mockExternalEdit }).__armadaExternalEdit = mockExternalEdit;
}
