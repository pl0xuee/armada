// The models new Claude agents start with, set in one place: the main agent's model and effort and
// the helper agents' model and effort. Used by the model setup popup (shown when a project is made)
// and Settings. The last change can be reverted.
import { api } from "./api";
import {
  clearWorkChoice,
  KEEP,
  notifyModelSetup,
  readWorkChoice,
  resolveWorkChoice,
  saveWorkChoice,
  WORK_TYPES,
} from "./modelGuide";
import type { TokenSaverOptions } from "./types";

export interface ModelSetup {
  /** Claude Code's alias for the main agent's model (`opus`, `sonnet`, `haiku`, `fable`). */
  model: string;
  effort: string;
  /** `sonnet` | `haiku`; null = helpers run on the main agent's model. */
  helperModel: string | null;
  /** `low` … `max`; null = Claude decides. */
  helperEffort: string | null;
}

/** Anthropic's model guide: Opus at medium effort, helpers on Sonnet. */
export const RECOMMENDED_SETUP: ModelSetup = {
  model: "opus",
  effort: "medium",
  helperModel: "sonnet",
  helperEffort: null,
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

export const sameSetup = (a: ModelSetup, b: ModelSetup) =>
  a.model === b.model && a.effort === b.effort && a.helperModel === b.helperModel && a.helperEffort === b.helperEffort;

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
  };
}

/** The "kind of work" that starts on this model and effort, or "my usual" (the remembered ones). */
export const workChoiceFor = (s: Pick<ModelSetup, "model" | "effort">) =>
  WORK_TYPES.find((w) => w.model === s.model && w.effort === s.effort)?.id ?? KEEP;

// ---------------------------------------------------------------- revert

/** Everything a setup change touches, as it was before. */
export interface SetupSnapshot {
  workChoice: string | null;
  claude: { model?: string; effort?: string };
  helperModel: string | null;
  helperEffort: string | null;
}

const UNDO_KEY = "kvistcode.modelSetupUndo";

export function readUndo(): SetupSnapshot | null {
  try {
    const raw = localStorage.getItem(UNDO_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SetupSnapshot>;
    const str = (x: unknown) => (typeof x === "string" ? x : null);
    const claude = v.claude && typeof v.claude === "object" ? v.claude : {};
    return {
      workChoice: str(v.workChoice),
      claude: {
        ...(str(claude.model) ? { model: claude.model } : {}),
        ...(str(claude.effort) ? { effort: claude.effort } : {}),
      },
      helperModel: str(v.helperModel),
      helperEffort: str(v.helperEffort),
    };
  } catch {
    return null;
  }
}

/** Drops what Revert would put back (a change that didn't happen after all). */
export const forgetRevert = () => writeUndo(null);

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

/** Remembers how things are now, so the change about to be made can be reverted. */
export async function rememberForRevert(saver: TokenSaverOptions | undefined) {
  const defaults = await Promise.resolve()
    .then(() => api.configDefaults())
    .catch(() => ({}) as Record<string, Record<string, string>>);
  const claude = defaults.claude ?? {};
  writeUndo({
    workChoice: readWorkChoice(),
    claude: { ...(claude.model ? { model: claude.model } : {}), ...(claude.effort ? { effort: claude.effort } : {}) },
    helperModel: saver?.subagentModel ?? null,
    helperEffort: saver?.subagentEffort ?? null,
  });
}

/** Makes `setup` what new Claude agents start with. Running agents keep what they have. */
export async function applySetup(setup: ModelSetup, saver: TokenSaverOptions | undefined, saveHelpers: SaveHelpers) {
  await rememberForRevert(saver);
  if (!(await saveHelpers({ subagentModel: setup.helperModel, subagentEffort: setup.helperEffort }))) {
    writeUndo(null);
    return false;
  }
  await api.setConfigDefaults("claude", { model: setup.model, effort: setup.effort });
  saveWorkChoice(workChoiceFor(setup));
  return true;
}

/** Puts back what the last setup change replaced. False if there was nothing, or it couldn't be saved. */
export async function revertSetup(saveHelpers: SaveHelpers): Promise<boolean> {
  const before = readUndo();
  if (!before) return false;
  if (!(await saveHelpers({ subagentModel: before.helperModel, subagentEffort: before.helperEffort }))) return false;
  await api.setConfigDefaults("claude", { model: before.claude.model ?? "", effort: before.claude.effort ?? "" });
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
