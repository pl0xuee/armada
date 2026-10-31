// Remembered launch choices (provider / account / folder / worktree), shared by the
// New agent dialog, the prompt-first home and "Start agent" in the command palette.
import { api } from "./api";
import { recallLocalModel } from "./local";
import { errorMessage, uuid } from "./utils";
import { CUSTOM_ACCOUNT_ID, PROVIDER_ORDER, type BuiltinProvider } from "./providers";
import type { Account, Agent, CreateAgentRequest, CustomAgent, Provider, ProviderInfo, Settings } from "./types";

const KEY = "armada.launchDefaults";

/** "claude" | "codex" | "grok" | "custom:<id>" */
export type LaunchChoice = string;

export interface LaunchDefaults {
  choice: LaunchChoice;
  /** Last account picked per built-in provider. */
  accounts: Partial<Record<BuiltinProvider, string>>;
  folder: string | null;
  worktree: boolean | null;
}

const EMPTY: LaunchDefaults = { choice: "claude", accounts: {}, folder: null, worktree: null };

export function readLaunchDefaults(): LaunchDefaults {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const v = JSON.parse(raw) as Partial<LaunchDefaults>;
    return {
      choice: typeof v.choice === "string" ? v.choice : EMPTY.choice,
      accounts: v.accounts && typeof v.accounts === "object" ? v.accounts : {},
      folder: typeof v.folder === "string" ? v.folder : null,
      worktree: typeof v.worktree === "boolean" ? v.worktree : null,
    };
  } catch {
    return EMPTY;
  }
}

export function saveLaunchDefaults(patch: Partial<LaunchDefaults>) {
  try {
    const cur = readLaunchDefaults();
    const next: LaunchDefaults = { ...cur, ...patch, accounts: { ...cur.accounts, ...(patch.accounts ?? {}) } };
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: defaults just aren't remembered */
  }
}

export function choiceKey(provider: Provider, customAgentId: string | null): LaunchChoice {
  return provider === "custom" && customAgentId ? `custom:${customAgentId}` : provider;
}

export function customFromChoice(choice: LaunchChoice, customAgents: CustomAgent[]): CustomAgent | undefined {
  return choice.startsWith("custom:") ? customAgents.find((c) => `custom:${c.id}` === choice && c.enabled) : undefined;
}

/** Best account for a provider: remembered → signed in → any. */
export function pickAccount(accounts: Account[], provider: BuiltinProvider, remembered?: string): Account | undefined {
  const mine = accounts.filter((a) => a.provider === provider);
  return (
    mine.find((a) => a.id === remembered && a.status?.loggedIn !== false) ??
    mine.find((a) => a.status?.loggedIn) ??
    mine[0]
  );
}

export interface ResolvedLaunch {
  choice: LaunchChoice;
  provider: Provider;
  accountId: string;
  customAgentId: string | null;
  folder: string;
  worktree: boolean;
}

/**
 * Turn remembered defaults into a launchable target, falling back to a sensible
 * provider (the first with a signed-in account) when the remembered one is gone.
 */
export function resolveLaunch(accounts: Account[], settings: Settings | null): ResolvedLaunch {
  const d = readLaunchDefaults();
  const customAgents = settings?.customAgents ?? [];
  const folder = d.folder ?? settings?.recentProjects[0] ?? "";
  const worktree = d.worktree ?? settings?.defaultWorktree ?? true;
  const custom = customFromChoice(d.choice, customAgents);
  if (custom) {
    return {
      choice: d.choice,
      provider: "custom",
      accountId: CUSTOM_ACCOUNT_ID,
      customAgentId: custom.id,
      folder,
      worktree,
    };
  }
  const wanted = (PROVIDER_ORDER as string[]).includes(d.choice) ? (d.choice as BuiltinProvider) : "claude";
  const order = [wanted, ...PROVIDER_ORDER.filter((p) => p !== wanted)];
  for (const p of order) {
    const acc = pickAccount(accounts, p, d.accounts[p]);
    if (acc && (acc.status?.loggedIn !== false || p === wanted)) {
      return { choice: p, provider: p, accountId: acc.id, customAgentId: null, folder, worktree };
    }
  }
  return { choice: wanted, provider: wanted, accountId: "", customAgentId: null, folder, worktree };
}

/** Remember a launch, so the next one starts from the same place. */
export function rememberLaunch(
  t: Pick<ResolvedLaunch, "provider" | "accountId" | "customAgentId" | "folder" | "worktree">,
) {
  saveLaunchDefaults({
    choice: choiceKey(t.provider, t.customAgentId),
    folder: t.folder || null,
    worktree: t.worktree,
    ...(t.provider !== "custom" ? { accounts: { [t.provider as BuiltinProvider]: t.accountId } } : {}),
  });
}

function launchRequest(
  t: ResolvedLaunch,
  prompt: string,
  permissionMode: "auto" | "ask" | null,
  worktree: boolean,
): CreateAgentRequest {
  return {
    provider: t.provider,
    accountId: t.accountId,
    customAgentId: t.customAgentId,
    projectPath: t.folder.trim(),
    prompt: prompt.trim(),
    title: null,
    worktree,
    model: t.provider === "local" ? recallLocalModel(t.accountId) : null,
    groupId: null,
    attachments: [],
    permissionMode,
  };
}

/** Create one agent from a resolved target + prompt (used by home and the palette). */
export async function launchAgent(
  t: ResolvedLaunch,
  prompt: string,
  permissionMode: "auto" | "ask" | null = null,
): Promise<Agent> {
  const agent = await api.createAgent(launchRequest(t, prompt, permissionMode, t.worktree));
  rememberLaunch(t);
  return agent;
}

/** Most separate agents one launch can start in the same project. */
export const MAX_PARALLEL_AGENTS = 8;

export function clampAgentCount(n: number): number {
  return Number.isFinite(n) ? Math.min(MAX_PARALLEL_AGENTS, Math.max(1, Math.floor(n))) : 1;
}

/** Whether a launch of `count` agents must run each in its own worktree (they'd overwrite each other's files otherwise). */
export const needsWorktree = (count: number) => count > 1;

export interface LaunchBatch {
  /** The group the agents share (so they can be shown together), null for a single agent. */
  groupId: string | null;
  created: Agent[];
  /** One message per agent that didn't start. */
  failed: string[];
}

/**
 * Starts `count` (1 to {@link MAX_PARALLEL_AGENTS}) separate agents on the same task in the same
 * project. With more than one, each gets its own worktree and branch and they share a group
 * (pass the previous batch's `groupId` when retrying the ones that failed). Never rejects:
 * agents that couldn't start are reported in `failed`, so a retry can start only those.
 */
export async function launchAgents(
  t: ResolvedLaunch,
  prompt: string,
  permissionMode: "auto" | "ask" | null,
  count: number,
  groupId: string | null = null,
): Promise<LaunchBatch> {
  const n = clampAgentCount(count);
  // Retrying the failed ones of a batch (it has a group) keeps them isolated like their siblings.
  const worktree = t.worktree || needsWorktree(n) || groupId !== null;
  const group = groupId ?? (needsWorktree(n) ? uuid() : null);
  const results = await Promise.allSettled(
    // Async, so a throw while building the request is a failed agent, not an escaped exception.
    Array.from({ length: n }, async () =>
      api.createAgent({ ...launchRequest(t, prompt, permissionMode, worktree), groupId: group }),
    ),
  );
  const created: Agent[] = [];
  const failed: string[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") created.push(r.value);
    else failed.push(errorMessage(r.reason));
  }
  if (created.length > 0) rememberLaunch(t);
  return { groupId: group, created, failed };
}

/** Projects found on this computer, fetched once per session. */
let discovered: Promise<string[]> | null = null;
export function discoverProjectsOnce(): Promise<string[]> {
  discovered ??= api.discoverProjects().catch((e: unknown) => {
    discovered = null;
    throw e;
  });
  return discovered;
}

// ---------------------------------------------------------------- preflight

export interface PreflightIssue {
  id: "signed_out" | "not_installed" | "no_adapter" | "not_git";
  text: string;
}

/**
 * Warnings shown before launching (New agent dialog and the home composer). They don't
 * block: a signed-out account or a missing CLI makes the agent fail to start, and worktrees
 * need a git repository. `isGitRepo` is the backend's answer for the folder (null while
 * checking or unknown, so nothing is flagged until it's known).
 */
export function preflight(p: {
  provider: Provider;
  account: Account | undefined;
  providerInfo: ProviderInfo | undefined;
  folder: string;
  worktree: boolean;
  isGitRepo: boolean | null;
}): PreflightIssue[] {
  const out: PreflightIssue[] = [];
  if (p.provider !== "custom") {
    if (p.account?.status && !p.account.status.loggedIn) {
      out.push({
        id: "signed_out",
        text:
          p.provider === "local"
            ? `${p.account.name} isn't running, so the agent can't start. Start the server first.`
            : `${p.account.name} isn't signed in, so the agent may fail to start.`,
      });
    }
    if (p.providerInfo && !p.providerInfo.installed) {
      out.push({
        id: "not_installed",
        text: `${p.providerInfo.displayName} CLI isn't installed. Install it from Settings → Providers.`,
      });
    } else if (p.providerInfo?.adapterRequired && !p.providerInfo.adapterInstalled) {
      out.push({
        id: "no_adapter",
        text: `${p.providerInfo.displayName} needs its ACP adapter. Install it from Settings → Providers.`,
      });
    }
  }
  const folder = p.folder.trim();
  if (p.worktree && folder && p.isGitRepo === false) {
    out.push({
      id: "not_git",
      text: "This folder isn't a git repository with at least one commit, so a worktree can't be created. Turn Worktree off, or pick a repository.",
    });
  }
  return out;
}
