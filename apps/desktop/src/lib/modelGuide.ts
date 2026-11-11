// Which Claude model for which work. From Anthropic's "Which Claude model should you build with"
// (claude.dev/blog, Nov 2026): start on Opus at medium effort; Sonnet for well-scoped, routine
// work; Haiku for quick or bulk jobs; Fable for big refactors and deep research; try a higher
// effort before a bigger model; switch models at a natural break. No prices or benchmark numbers
// live here (they go stale): those are in docs/TOKEN-SAVING.md.
import type { Agent, ConfigOption } from "./types";

export interface WorkType {
  id: string;
  label: string;
  blurb: string;
  /** Claude Code's alias for the model (`opus`, `sonnet`, `haiku`, `fable`). */
  model: string;
  effort: string;
}

export const WORK_TYPES: readonly WorkType[] = [
  { id: "everyday", label: "Everyday coding", blurb: "Features, debugging, reviews", model: "opus", effort: "medium" },
  {
    id: "routine",
    label: "Routine tasks",
    blurb: "Clear, well-scoped work, cheaper",
    model: "sonnet",
    effort: "medium",
  },
  { id: "quick", label: "Quick or bulk", blurb: "Lookups and simple jobs, fastest", model: "haiku", effort: "medium" },
  {
    id: "big",
    label: "Big refactor or research",
    blurb: "Migrations, architecture, deep research",
    model: "fable",
    effort: "medium",
  },
];

/** "Don't pick for me": the model and effort the agent would have started with anyway. */
export const KEEP = "keep";
export type WorkChoice = string;

const KEY = "kvistcode.workType";

export function readWorkChoice(): WorkChoice | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === KEEP || WORK_TYPES.some((w) => w.id === v) ? v : null;
  } catch {
    return null;
  }
}

export function saveWorkChoice(choice: WorkChoice) {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    /* storage unavailable: the pick just isn't remembered */
  }
  notifyModelSetup();
}

/** Forgets the pick, so launches go back to the default (used when a model setup is reverted). */
export function clearWorkChoice() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: nothing was remembered */
  }
  notifyModelSetup();
}

const listeners = new Set<() => void>();

/** Calls `fn` whenever the models new agents start with change here (the pick, a setup, a revert). */
export function onModelSetupChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function notifyModelSetup() {
  for (const fn of [...listeners]) fn();
}

/**
 * What a launch starts on when nothing was picked yet: someone who already chose their own model or
 * effort keeps them (nothing changes silently); a fresh install gets the recommended Opus at medium.
 */
export function defaultWorkChoice(claudeDefaults: Record<string, string> | undefined): WorkChoice {
  return claudeDefaults && (claudeDefaults.model || claudeDefaults.effort) ? KEEP : WORK_TYPES[0].id;
}

/** The choice in effect: the last pick if it still makes sense, else the default. */
export function resolveWorkChoice(
  stored: WorkChoice | null,
  claudeDefaults: Record<string, string> | undefined,
  available: readonly WorkType[],
): WorkChoice {
  if (stored === KEEP) return KEEP;
  if (stored && available.some((w) => w.id === stored)) return stored;
  const d = defaultWorkChoice(claudeDefaults);
  return d === KEEP || available.some((w) => w.id === d) ? d : KEEP;
}

const modelOption = (a: Agent): ConfigOption | undefined => a.configOptions?.find((o) => o.id === "model");

/**
 * The work types whose model this Claude Code offers, judged from the Claude agents already running
 * (an older Claude Code, or a plan without Fable, lacks some). With none to look at, all of them.
 */
export function availableWorkTypes(agents: readonly Agent[]): readonly WorkType[] {
  const offered = new Set<string>();
  for (const a of agents) {
    if (a.provider !== "claude") continue;
    for (const c of modelOption(a)?.options ?? []) offered.add(c.value);
  }
  return offered.size === 0 ? WORK_TYPES : WORK_TYPES.filter((w) => offered.has(w.model));
}

/** What to start a new agent with: the model and effort of the pick (Claude only; nothing otherwise). */
export function choicesFor(provider: string, choice: WorkChoice): Record<string, string> {
  if (provider !== "claude" || choice === KEEP) return {};
  const w = WORK_TYPES.find((x) => x.id === choice);
  return w ? { model: w.model, effort: w.effort } : {};
}

// ---------------------------------------------------------------- hints in the menus

const EFFORT_HINTS: Record<string, string> = {
  low: "Fastest and cheapest. Good when a test can check the result",
  medium: "A good start for most work",
  high: "For harder problems",
  xhigh: "For the hardest problems. A bigger model can be the better buy",
  max: "For the hardest problems. A bigger model can be the better buy",
};

const MODEL_HINTS: Record<string, string> = {
  opus: "Everyday engineering and debugging",
  sonnet: "Clear, routine work at a lower cost",
  haiku: "Quick lookups and bulk jobs",
  fable: "Big refactors, migrations and deep research",
};

/** A short "good for" line for a choice that Claude Code gave no description for (Claude agents only). */
export function choiceHint(agent: Pick<Agent, "provider">, option: ConfigOption, value: string): string | null {
  if (agent.provider !== "claude") return null;
  if (option.id === "effort") return EFFORT_HINTS[value] ?? null;
  if (option.id === "model") return MODEL_HINTS[value] ?? null;
  return null;
}

/** A line under a Claude menu that says when to use the option (null for other options). */
export function menuNote(agent: Pick<Agent, "provider">, option: ConfigOption): string | null {
  if (agent.provider !== "claude") return null;
  if (option.id === "effort")
    return "Before a bigger model, try one effort level higher. Past High, a bigger model is often the better buy.";
  if (option.id === "model") return "Switch at a break: a new model re-reads the whole conversation once.";
  return null;
}

// ---------------------------------------------------------------- switching on a long conversation

/** Conversation size (tokens) above which changing the model is worth a word first. */
export const SWITCH_NOTE_TOKENS = 100_000;

/** Whether picking `value` for this option should first offer to compact: a Claude model change on a long conversation. */
export function switchNeedsNote(agent: Agent, option: ConfigOption, value: string): boolean {
  return (
    agent.provider === "claude" &&
    option.id === "model" &&
    value !== option.currentValue &&
    (agent.contextUsed ?? 0) >= SWITCH_NOTE_TOKENS
  );
}

// ---------------------------------------------------------------- moving the agents you have

/** An open Claude agent that is not on the recommended model and effort yet. */
export interface SwitchTarget {
  agent: Agent;
  /** Its model changes and its conversation is long, so its next message costs more once. */
  long: boolean;
}

/**
 * Open Claude agents that are not on Opus at medium effort. One whose Claude Code doesn't offer Opus is
 * left alone; one that hasn't reported its options yet is included (they apply when it starts).
 */
export function agentsOffRecommended(agents: readonly Agent[]): SwitchTarget[] {
  const rec = WORK_TYPES[0];
  const out: SwitchTarget[] = [];
  for (const a of agents) {
    if (a.provider !== "claude" || a.archived) continue;
    const model = modelOption(a);
    const effort = a.configOptions?.find((o) => o.id === "effort");
    if (model && !model.options.some((c) => c.value === rec.model)) continue;
    const onModel = model?.currentValue === rec.model;
    const onEffort = model ? !effort || effort.currentValue === rec.effort : false;
    if (onModel && onEffort) continue;
    out.push({ agent: a, long: !!model && !onModel && (a.contextUsed ?? 0) >= SWITCH_NOTE_TOKENS });
  }
  return out;
}
