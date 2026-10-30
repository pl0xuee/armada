// Project settings: the files Claude Code / Codex read from a project (instruction files,
// permission rules, hooks, slash commands, skills). Types mirror
// crates/armada-core/src/project_config.rs; the helpers are pure.

export type RuleKind = "allow" | "ask" | "deny";
export type SettingsScope = "shared" | "local";
export type InstructionFileName = "CLAUDE.md" | "AGENTS.md";

export const RULE_KINDS: RuleKind[] = ["allow", "ask", "deny"];
export const MAX_RULE_CHARS = 1000;

export interface PermissionRules {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface InstructionDoc {
  file: InstructionFileName;
  path: string;
  exists: boolean;
  content: string;
  /** Why the file can't be shown or edited (too large, outside the project…). */
  error: string | null;
}

export interface HookEntry {
  event: string;
  matcher: string | null;
  command: string;
  scope: SettingsScope;
}

export interface SettingsFile {
  scope: SettingsScope;
  path: string;
  exists: boolean;
  rules: PermissionRules;
  hooks: HookEntry[];
  /** Set when the file can't be edited from here (invalid JSON…); the file is left untouched. */
  error: string | null;
}

export interface ConfigEntry {
  name: string;
  description: string;
  path: string;
}

export interface ProjectConfig {
  root: string;
  instructions: InstructionDoc[];
  /** `~/.claude/CLAUDE.md`, read-only. */
  userInstructions: InstructionDoc | null;
  settings: SettingsFile[];
  commands: ConfigEntry[];
  skills: ConfigEntry[];
}

export const emptyRules = (): PermissionRules => ({ allow: [], ask: [], deny: [] });

/** Why `rule` can't be stored (the backend enforces the same), or null when it's fine. */
export function ruleProblem(rule: string): string | null {
  const r = rule.trim();
  if (!r) return "Enter a rule, for example Bash(npm run test:*)";
  if (/[\u0000-\u001f\u007f]/.test(r)) return "A rule must be a single line of plain text";
  if ([...r].length > MAX_RULE_CHARS) return `A rule can be at most ${MAX_RULE_CHARS} characters`;
  return null;
}

/** `list` with `rule` appended; `error` explains why it wasn't (invalid, or already there). */
export function addRule(list: string[], rule: string): { list: string[]; error: string | null } {
  const problem = ruleProblem(rule);
  if (problem) return { list, error: problem };
  const r = rule.trim();
  if (list.includes(r)) return { list, error: "That rule is already in the list" };
  return { list: [...list, r], error: null };
}

export function removeRule(list: string[], rule: string): string[] {
  return list.filter((r) => r !== rule);
}

/** Whether a rule exists in another list of the same file (allow vs deny conflicts are worth flagging). */
export function otherKindsHolding(rules: PermissionRules, kind: RuleKind, rule: string): RuleKind[] {
  return RULE_KINDS.filter((k) => k !== kind && rules[k].includes(rule));
}

export function ruleCount(rules: PermissionRules): number {
  return rules.allow.length + rules.ask.length + rules.deny.length;
}

/** Projects to choose from: the ones agents run in, then recent ones; no duplicates, order kept. */
export function projectChoices(agentProjects: string[], recent: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...agentProjects, ...recent]) {
    const key = p.replace(/[\\/]+$/, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** `Stop`, `PreToolUse`… grouped in the order events first appear. */
export function groupHooks(hooks: HookEntry[]): { event: string; hooks: HookEntry[] }[] {
  const groups = new Map<string, HookEntry[]>();
  for (const h of hooks) groups.set(h.event, [...(groups.get(h.event) ?? []), h]);
  return [...groups].map(([event, list]) => ({ event, hooks: list }));
}
