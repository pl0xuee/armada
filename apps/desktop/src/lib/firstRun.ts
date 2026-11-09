// Pure logic for the first-run "Your AI tools" and sign-in steps: what is ticked, what each
// tool is doing, what the main button says, and which agent to offer a sign-in for first.
// The store that runs the installs is store/installs.ts.
import type { Account, Provider, ProviderInfo } from "./types";

/** Same test as Settings → Providers (components/settings/ProviderCard.tsx). */
export function toolReady(p: ProviderInfo): boolean {
  return p.installed && (!p.adapterRequired || p.adapterInstalled);
}

export type RunStatus = "queued" | "installing" | "done" | "failed";
export interface AgentRun {
  status: RunStatus;
  /** Why it failed, in a short plain sentence. */
  reason?: string;
}
/** What this run of the app has asked the installer to do, per provider. */
export type Runs = Partial<Record<Provider, AgentRun>>;

export type RowState = "ready" | "queued" | "installing" | "failed" | "idle";

/**
 * What a row shows. This run of the installer is the word on it: a launcher file can exist
 * (npm links it) before the install finished or the version check passed, so "installed" from
 * detection counts only when nothing was run for the tool.
 */
export function rowState(info: ProviderInfo, run: AgentRun | undefined): RowState {
  if (run) return run.status === "done" ? "ready" : run.status;
  return toolReady(info) ? "ready" : "idle";
}

/** Tools that will be installed by the main button: missing, not started, and not unticked. */
export function selectedTools(providers: ProviderInfo[], runs: Runs, unticked: Provider[]): Provider[] {
  return providers
    .filter((p) => rowState(p, runs[p.provider]) === "idle" && !unticked.includes(p.provider))
    .map((p) => p.provider);
}

export interface PrimaryAction {
  kind: "install" | "continue";
  label: string;
  disabled: boolean;
  /** Why the button is off, in plain words. */
  reason?: string;
}

/** The main button of the step: install what is ticked, or carry on once something is ready. */
export function primaryAction(states: RowState[], selected: number): PrimaryAction {
  const ready = states.filter((s) => s === "ready").length;
  const busy = states.filter((s) => s === "queued" || s === "installing").length;
  if (selected > 0) return { kind: "install", label: `Install ${selected} selected`, disabled: false };
  if (ready > 0) return { kind: "continue", label: "Continue", disabled: false };
  if (busy > 0) {
    return {
      kind: "install",
      label: "Installing…",
      disabled: true,
      reason: "You can skip ahead; the install keeps going.",
    };
  }
  const failed = states.some((s) => s === "failed");
  return {
    kind: "install",
    label: "Install selected",
    disabled: true,
    reason: failed ? "Try a tool again, or skip for now." : "Tick at least one tool to install.",
  };
}

/**
 * The way past the step that is always there: shown beside the main button whenever that button
 * isn't already "Continue", so nobody is stuck on a failed or slow install.
 */
export function moveOnAction(states: RowState[], primary: PrimaryAction): { label: string } | null {
  if (primary.kind === "continue") return null;
  return { label: states.some((s) => s === "ready") ? "Continue" : "Skip for now" };
}

/** A short note under the list while installs go on, or null. */
export function progressNote(states: RowState[]): string | null {
  const busy = states.filter((s) => s === "queued" || s === "installing").length;
  if (busy === 0) return null;
  const ready = states.filter((s) => s === "ready").length;
  if (ready === 0) return null;
  return busy === 1
    ? "One more is still installing. You can carry on; it keeps going."
    : `${busy} more are still installing. You can carry on; they keep going.`;
}

// ---- reading the installer's log ---------------------------------------------------------

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Cuts a failure message down to one short line. */
export function shortReason(text: string): string {
  const first = text.split(/\s*\n\s*/)[0].trim() || "It didn't finish.";
  return first.length > 140 ? `${first.slice(0, 137).trimEnd()}…` : first;
}

/**
 * Moves the runs along for one line the installer printed. The lines are the core's:
 * "Setting up X", "✓ X is ready (…)" / "✓ X is already installed.", "✗ X: reason".
 * `finished` names the tool that just finished installing (not one that was already there).
 */
export function applyLogLine(
  runs: Runs,
  rawLine: string,
  providers: ProviderInfo[],
): { runs: Runs; finished?: Provider } {
  const line = stripAnsi(rawLine).trim();
  const byName = (name: string) => providers.find((p) => p.displayName === name)?.provider;
  let m = /^Setting up (.+)$/.exec(line);
  if (m) {
    const p = byName(m[1]);
    return p ? { runs: { ...runs, [p]: { status: "installing" } } } : { runs };
  }
  m = /^✓ (.+?) is ready\b/.exec(line);
  if (m) {
    const p = byName(m[1]);
    return p ? { runs: { ...runs, [p]: { status: "done" } }, finished: p } : { runs };
  }
  m = /^✓ (.+?) is already installed/.exec(line);
  if (m) {
    const p = byName(m[1]);
    return p ? { runs: { ...runs, [p]: { status: "done" } } } : { runs };
  }
  m = /^✗ (.+?): (.+)$/.exec(line);
  if (m) {
    const p = byName(m[1]);
    return p ? { runs: { ...runs, [p]: { status: "failed", reason: shortReason(m[2]) } } } : { runs };
  }
  return { runs };
}

/** When one install job ends: anything of its still waiting or running did not finish. */
export function applyExit(runs: Runs, jobProviders: Provider[], code: number | null): Runs {
  const next = { ...runs };
  for (const p of jobProviders) {
    const s = next[p]?.status;
    if (s !== "queued" && s !== "installing") continue;
    next[p] = code === 0 ? { status: "done" } : { status: "failed", reason: "It stopped before it finished." };
  }
  return next;
}

// ---- sign-in right after install ---------------------------------------------------------

/**
 * The accounts to offer a sign-in for, in the order the tools finished installing: the
 * tool's own (system) account, only for tools that are ready, and not for anyone already
 * signed in. Custom and local agents have no sign-in here.
 */
export function signInOffers(
  installed: Provider[],
  providers: ProviderInfo[],
  accounts: Account[],
  runs: Runs = {},
): Account[] {
  const offers: Account[] = [];
  for (const provider of installed) {
    if (provider === "custom" || provider === "local") continue;
    const info = providers.find((p) => p.provider === provider);
    if (!info || !toolReady(info) || rowState(info, runs[provider]) !== "ready") continue;
    const account = accounts.find((a) => a.provider === provider && a.isSystem);
    if (!account || account.status?.loggedIn) continue;
    if (!offers.some((o) => o.id === account.id)) offers.push(account);
  }
  return offers;
}

/** The account list with the offered ones first (the rest keep their order). */
export function offeredFirst(accounts: Account[], offers: Account[]): Account[] {
  const first = offers.flatMap((o) => accounts.filter((a) => a.id === o.id));
  return [...first, ...accounts.filter((a) => !offers.some((o) => o.id === a.id))];
}
