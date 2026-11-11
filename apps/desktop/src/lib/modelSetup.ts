// The models new agents start with, set in one place. For Claude: the main agent's model and effort
// and the helper agents' model and effort. For Codex, Grok and custom agents (Gemini CLI, ...): the
// model and effort their agents offer. Used by the model setup popup (shown when a project is made)
// and Settings. The last change can be reverted.
import { api } from "./api";
import { configDefaultsKey, isRememberableOption } from "./configMemory";
import { identityFor } from "./identity";
import {
  clearWorkChoice,
  KEEP,
  notifyModelSetup,
  readWorkChoice,
  resolveWorkChoice,
  saveWorkChoice,
  WORK_TYPES,
} from "./modelGuide";
import type { Agent, ConfigOption, CustomAgent, ProviderInfo, TokenSaverOptions } from "./types";

export interface ModelSetup {
  /** Claude Code's alias for the main agent's model (`opus`, `sonnet`, `haiku`, `fable`). */
  model: string;
  effort: string;
  /** `sonnet` | `haiku`; null = helpers run on the main agent's model. */
  helperModel: string | null;
  /** `low` … `max`; null = Claude decides. */
  helperEffort: string | null;
  /** Other providers by identity key (`codex`, `grok`, `custom:<id>`): option id -> value ("" = their default). */
  others: Record<string, Record<string, string>>;
}

/** Anthropic's model guide: Opus at medium effort, helpers on Sonnet. */
export const RECOMMENDED_SETUP: ModelSetup = {
  model: "opus",
  effort: "medium",
  helperModel: "sonnet",
  helperEffort: null,
  others: {},
};

export const MAIN_MODELS = [
  { value: "opus", label: "Opus", hint: "Everyday engineering and debugging" },
  { value: "sonnet", label: "Sonnet", hint: "Clear, routine work at a lower cost" },
  { value: "haiku", label: "Haiku", hint: "Quick lookups and bulk jobs" },
  { value: "fable", label: "Fable", hint: "Big refactors, migrations and deep research" },
];

export const EFFORTS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];

export const HELPER_MODELS = [
  { value: "same", label: "Same as the main agent" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku (cheapest)" },
];

export const HELPER_EFFORTS = [{ value: "auto", label: "Claude decides" }, ...EFFORTS];

const nameOf = (list: { value: string; label: string }[], v: string) => list.find((x) => x.value === v)?.label ?? v;

/** "Opus · Medium, helpers on Sonnet" */
export function describeSetup(s: ModelSetup): string {
  const helper = s.helperModel ? nameOf(HELPER_MODELS, s.helperModel).replace(" (cheapest)", "") : "the same model";
  const helperEffort = s.helperEffort ? ` at ${nameOf(EFFORTS, s.helperEffort).toLowerCase()} effort` : "";
  return `${nameOf(MAIN_MODELS, s.model)} at ${nameOf(EFFORTS, s.effort).toLowerCase()} effort, helpers on ${helper}${helperEffort}`;
}

/** Whether two setups pick the same Claude models (other providers aside). */
export const sameClaude = (a: ModelSetup, b: ModelSetup) =>
  a.model === b.model && a.effort === b.effort && a.helperModel === b.helperModel && a.helperEffort === b.helperEffort;

const keysOf = (a: object, b: object) => [...new Set([...Object.keys(a), ...Object.keys(b)])];
export const sameValues = (a: Record<string, string> = {}, b: Record<string, string> = {}) =>
  keysOf(a, b).every((k) => (a[k] ?? "") === (b[k] ?? ""));

export const sameSetup = (a: ModelSetup, b: ModelSetup) =>
  sameClaude(a, b) && keysOf(a.others, b.others).every((k) => sameValues(a.others[k], b.others[k]));

// ---------------------------------------------------------------- other providers

/** A provider besides Claude, with the model and effort options its agents offer (null: not known yet). */
export interface OtherProvider {
  key: string;
  name: string;
  /** Kvistcode has run one of its agents (so a missing option means it doesn't offer one). */
  seen: boolean;
  model: ConfigOption | null;
  effort: ConfigOption | null;
}

const isModel = (o: ConfigOption) => o.category === "model" || o.id === "model";
const isEffort = (o: ConfigOption) => o.category === "thought_level" || /effort|reasoning|thinking/i.test(o.id);

/**
 * Codex, Grok and the enabled custom agents (Gemini CLI, ...), each with the model and effort options
 * of its most recently active main agent: a provider's models are only known from one of its agents.
 * A built-in provider shows when it is installed or has agents. Local models belong to their server,
 * so they are left out.
 */
export function otherProviders(
  agents: readonly Agent[],
  providers: readonly ProviderInfo[],
  customAgents: readonly CustomAgent[],
): OtherProvider[] {
  const latest = new Map<string, Agent>();
  for (const a of agents) {
    if (a.parentId || !a.configOptions?.length) continue;
    const key = configDefaultsKey(a.provider, a.customAgentId);
    const cur = latest.get(key);
    if (!cur || a.lastActivityAt > cur.lastActivityAt) latest.set(key, a);
  }
  const list: { key: string; name: string }[] = [];
  for (const p of ["codex", "grok"] as const)
    if (agents.some((a) => a.provider === p) || providers.some((x) => x.provider === p && x.installed))
      list.push({ key: p, name: identityFor(p, null, [...customAgents]).short });
  for (const c of customAgents) if (c.enabled) list.push({ key: `custom:${c.id}`, name: c.name });
  return list.map(({ key, name }) => {
    const opts = (latest.get(key)?.configOptions ?? []).filter(isRememberableOption);
    const model = opts.find(isModel) ?? null;
    const seen = agents.some((a) => !a.parentId && configDefaultsKey(a.provider, a.customAgentId) === key);
    return { key, name, seen, model, effort: opts.find((o) => o !== model && isEffort(o)) ?? null };
  });
}

/** What each provider's new agents start with now ("" where nothing is remembered). */
export function othersFrom(
  defaults: Record<string, Record<string, string>>,
  list: readonly OtherProvider[],
): ModelSetup["others"] {
  const out: ModelSetup["others"] = {};
  for (const p of list) {
    const values: Record<string, string> = {};
    for (const o of [p.model, p.effort]) if (o) values[o.id] = defaults[p.key]?.[o.id] ?? "";
    if (Object.keys(values).length) out[p.key] = values;
  }
  return out;
}

/** The setup in effect: the "kind of work" pick (or the remembered model and effort) plus the helper settings. */
export function setupFrom(
  workChoice: string | null,
  claude: Record<string, string> | undefined,
  saver: Pick<TokenSaverOptions, "subagentModel" | "subagentEffort"> | undefined,
): ModelSetup {
  const w = WORK_TYPES.find((x) => x.id === resolveWorkChoice(workChoice, claude, WORK_TYPES));
  return {
    model: w?.model ?? claude?.model ?? RECOMMENDED_SETUP.model,
    effort: w?.effort ?? claude?.effort ?? RECOMMENDED_SETUP.effort,
    helperModel: saver?.subagentModel ?? null,
    helperEffort: saver?.subagentEffort ?? null,
    others: {},
  };
}

/** The "kind of work" that starts on this model and effort, or "my usual" (the remembered ones). */
export const workChoiceFor = (s: Pick<ModelSetup, "model" | "effort">) =>
  WORK_TYPES.find((w) => w.model === s.model && w.effort === s.effort)?.id ?? KEEP;

// ---------------------------------------------------------------- revert

/** Everything a setup change touches, as it was before ("" for a choice that wasn't remembered). */
export interface SetupSnapshot {
  workChoice: string | null;
  /** Remembered choices per provider identity, for the options the change sets. */
  defaults: Record<string, Record<string, string>>;
  helperModel: string | null;
  helperEffort: string | null;
  /** Which change this undoes (so an old Undo button can't undo a newer change). */
  id: number;
}

const UNDO_KEY = "kvistcode.modelSetupUndo";

const isStringMap = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === "object" && Object.values(v).every((x) => typeof x === "string");

export function readUndo(): SetupSnapshot | null {
  try {
    const raw = localStorage.getItem(UNDO_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SetupSnapshot>;
    const str = (x: unknown) => (typeof x === "string" ? x : null);
    const defaults: SetupSnapshot["defaults"] = {};
    if (v.defaults && typeof v.defaults === "object")
      for (const [k, m] of Object.entries(v.defaults)) if (isStringMap(m)) defaults[k] = m;
    return {
      workChoice: str(v.workChoice),
      defaults,
      helperModel: str(v.helperModel),
      helperEffort: str(v.helperEffort),
      id: typeof v.id === "number" ? v.id : 0,
    };
  } catch {
    return null;
  }
}

function writeUndo(s: SetupSnapshot | null) {
  try {
    if (s) localStorage.setItem(UNDO_KEY, JSON.stringify(s));
    else localStorage.removeItem(UNDO_KEY);
  } catch {
    /* storage unavailable: there is just nothing to revert */
  }
  notifyModelSetup();
}

/** Saves the helper settings; resolves false (after telling the user) when they couldn't be saved. */
export type SaveHelpers = (patch: Pick<TokenSaverOptions, "subagentModel" | "subagentEffort">) => Promise<boolean>;

let lastId = 0;

/** A change that can be reverted: its id, and `cancel` for when it didn't happen after all. */
export interface PendingChange {
  id: number;
  /** Puts back what Revert offered before this change. */
  cancel: () => void;
}

/**
 * Remembers how things are now, so the change about to be made can be reverted. `touched` lists the
 * remembered choices (option ids per provider identity) the change sets.
 */
export async function rememberForRevert(
  saver: TokenSaverOptions | undefined,
  touched: Record<string, readonly string[]> = { claude: ["model", "effort"] },
): Promise<PendingChange> {
  const previous = readUndo();
  const id = (lastId = Math.max(Date.now(), lastId + 1));
  const now = await Promise.resolve()
    .then(() => api.configDefaults())
    .catch(() => ({}) as Record<string, Record<string, string>>);
  const defaults: SetupSnapshot["defaults"] = {};
  for (const [key, ids] of Object.entries(touched))
    defaults[key] = Object.fromEntries(ids.map((id) => [id, now[key]?.[id] ?? ""]));
  writeUndo({
    workChoice: readWorkChoice(),
    defaults,
    helperModel: saver?.subagentModel ?? null,
    helperEffort: saver?.subagentEffort ?? null,
    id,
  });
  return { id, cancel: () => writeUndo(previous) };
}

/**
 * Makes `setup` what new agents start with. Running agents keep what they have. Given `before` (what
 * the form started from), only what differs is saved: changing Codex alone leaves Claude as it was.
 * Resolves to the change's id (for Undo), or null if nothing was saved.
 */
export async function applySetup(
  setup: ModelSetup,
  saver: TokenSaverOptions | undefined,
  saveHelpers: SaveHelpers,
  before?: ModelSetup,
): Promise<number | null> {
  const claude = !before || !sameClaude(before, setup);
  const others = Object.entries(setup.others).filter(([k, v]) => !before || !sameValues(before.others[k], v));
  const touched: Record<string, string[]> = claude ? { claude: ["model", "effort"] } : {};
  for (const [key, values] of others) touched[key] = Object.keys(values);
  const change = await rememberForRevert(saver, touched);
  if (claude) {
    if (!(await saveHelpers({ subagentModel: setup.helperModel, subagentEffort: setup.helperEffort }))) {
      change.cancel();
      return null;
    }
    await api.setConfigDefaults("claude", { model: setup.model, effort: setup.effort });
  }
  for (const [key, values] of others) await api.setConfigDefaults(key, values);
  if (claude) saveWorkChoice(workChoiceFor(setup));
  return change.id;
}

/**
 * Puts back what the last setup change replaced. Given `id`, only if that change is still the last one.
 * False if there was nothing to put back, or it couldn't be saved.
 */
export async function revertSetup(saveHelpers: SaveHelpers, id?: number): Promise<boolean> {
  const before = readUndo();
  if (!before || (id !== undefined && before.id !== id)) return false;
  if (!(await saveHelpers({ subagentModel: before.helperModel, subagentEffort: before.helperEffort }))) return false;
  for (const [key, values] of Object.entries(before.defaults)) await api.setConfigDefaults(key, values);
  if (before.workChoice) saveWorkChoice(before.workChoice);
  else clearWorkChoice();
  writeUndo(null);
  return true;
}

// ---------------------------------------------------------------- asking on a new project

const ASK_KEY = "kvistcode.askModelsOnNewProject";

export function askOnNewProject(): boolean {
  try {
    return localStorage.getItem(ASK_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setAskOnNewProject(ask: boolean) {
  try {
    localStorage.setItem(ASK_KEY, ask ? "1" : "0");
  } catch {
    /* storage unavailable: it asks again next time */
  }
}
