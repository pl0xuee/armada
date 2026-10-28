/** The "new agent" form model: which agent types can be started, and request validation. */
import { agentIdentity } from "./meta";
import { storage } from "./storage";
import type { Attachment, CreateAgentRequest, PermissionMode, Provider, RemoteAccount, RemoteCustomAgent } from "./types";

export interface AgentChoice {
  /** "claude" | "codex" | "grok" | "custom:<id>" */
  key: string;
  provider: Provider;
  customAgentId: string | null;
  name: string;
  color: string;
  /** Accounts that can run it (same provider). */
  accounts: RemoteAccount[];
}

const BUILT_IN: Provider[] = ["claude", "codex", "grok"];

/**
 * Built-in providers and each *enabled* custom agent, but only those that
 * have an account to run them (custom agents run on "custom" accounts).
 */
export function agentChoices(accounts: RemoteAccount[], customAgents: RemoteCustomAgent[]): AgentChoice[] {
  const byProvider = (p: Provider) => accounts.filter((a) => a.provider === p);
  const out: AgentChoice[] = [];
  for (const p of BUILT_IN) {
    const accs = byProvider(p);
    if (!accs.length) continue;
    const id = agentIdentity({ provider: p, customAgentId: null }, {});
    out.push({ key: p, provider: p, customAgentId: null, name: id.short, color: id.color, accounts: accs });
  }
  const customAccounts = byProvider("custom");
  if (customAccounts.length) {
    const map = Object.fromEntries(customAgents.map((c) => [c.id, c]));
    for (const c of customAgents) {
      if (c.enabled === false) continue;
      const id = agentIdentity({ provider: "custom", customAgentId: c.id }, map);
      out.push({ key: `custom:${c.id}`, provider: "custom", customAgentId: c.id, name: id.short, color: id.color, accounts: customAccounts });
    }
  }
  return out;
}

export interface NewAgentForm {
  choiceKey: string | null;
  accountId: string | null;
  projectPath: string;
  worktree: boolean;
  title: string;
  prompt: string;
  attachments: Attachment[];
  /** Advanced: provider-specific model id; empty = the agent's default. */
  model: string;
  /** null = not offered (older server): the field is omitted. */
  permissionMode: PermissionMode | null;
}

/** Why an account probably can't start an agent right now (null = looks fine or unknown). */
export function accountProblem(account: Pick<RemoteAccount, "loggedIn" | "error"> | undefined | null): string | null {
  if (!account) return null;
  if (account.loggedIn === false) return "This account is signed out. Sign in on the computer first.";
  if (account.error) return `This account has a problem: ${account.error}`;
  return null;
}

export type Validation = { ok: true; request: CreateAgentRequest } | { ok: false; error: string; field: "agent" | "account" | "folder" };

/** Absolute POSIX path, `~/…`, or a Windows drive/UNC path. */
export function looksLikePath(p: string): boolean {
  const s = p.trim();
  return /^(\/|~(\/|$)|[A-Za-z]:[\\/]|\\\\)/.test(s);
}

export function validate(form: NewAgentForm, choices: AgentChoice[]): Validation {
  const choice = choices.find((c) => c.key === form.choiceKey);
  if (!choice) return { ok: false, error: "Choose which agent to start.", field: "agent" };
  const account = choice.accounts.find((a) => a.id === form.accountId);
  if (!account) return { ok: false, error: "Choose an account.", field: "account" };
  const projectPath = form.projectPath.trim();
  if (!projectPath) return { ok: false, error: "Choose a folder for the agent to work in.", field: "folder" };
  if (!looksLikePath(projectPath)) return { ok: false, error: "Enter the full path of a folder on your computer.", field: "folder" };
  const request: CreateAgentRequest = {
    provider: choice.provider,
    accountId: account.id,
    projectPath,
    worktree: form.worktree,
  };
  if (choice.customAgentId) request.customAgentId = choice.customAgentId;
  const prompt = form.prompt.trim();
  if (prompt) request.prompt = prompt;
  const title = form.title.trim();
  if (title) request.title = title;
  if (form.attachments.length) request.attachments = form.attachments;
  const model = form.model.trim();
  if (model) request.model = model;
  if (form.permissionMode) request.permissionMode = form.permissionMode;
  return { ok: true, request };
}

// ---------------------------------------------------------------------------
// Remember the last choices so starting the next agent is one tap.

const LAST_KEY = "armada.newAgent.last";

export interface LastChoice {
  choiceKey: string;
  accountId: string;
  projectPath: string;
}

export function loadLast(): Partial<LastChoice> {
  try {
    const v = JSON.parse(storage.get(LAST_KEY) ?? "{}") as Partial<LastChoice>;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function saveLast(v: LastChoice) {
  storage.set(LAST_KEY, JSON.stringify(v));
}

/** Initial form values: last choices when still valid, else sensible defaults. */
export function initialForm(
  choices: AgentChoice[],
  projects: string[],
  defaultWorktree: boolean,
  last = loadLast(),
  defaultPermissionMode: PermissionMode | null = null,
): NewAgentForm {
  const choice = choices.find((c) => c.key === last.choiceKey) ?? choices[0] ?? null;
  const account = choice?.accounts.find((a) => a.id === last.accountId) ?? choice?.accounts[0] ?? null;
  const projectPath = last.projectPath && projects.includes(last.projectPath) ? last.projectPath : (projects[0] ?? "");
  return {
    choiceKey: choice?.key ?? null,
    accountId: account?.id ?? null,
    projectPath,
    worktree: defaultWorktree,
    title: "",
    prompt: "",
    attachments: [],
    model: "",
    permissionMode: defaultPermissionMode,
  };
}
