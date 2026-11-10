// Which Claude model for which work, mirrored from apps/desktop/src/lib/modelGuide.ts (the phone has its
// own copy of the logic). Start on Opus at medium effort; Sonnet for routine work; Haiku for quick or
// bulk jobs; Fable for big refactors and deep research. No prices here: they go stale (docs/TOKEN-SAVING.md).
import { storage } from "./storage";
import type { Agent, ConfigOption } from "./types";

export interface WorkType {
  id: string;
  label: string;
  blurb: string;
  model: string;
  effort: string;
}

export const WORK_TYPES: readonly WorkType[] = [
  { id: "everyday", label: "Everyday coding", blurb: "Opus. Features, debugging, reviews", model: "opus", effort: "medium" },
  { id: "routine", label: "Routine tasks", blurb: "Sonnet. Clear, well-scoped work, cheaper", model: "sonnet", effort: "medium" },
  { id: "quick", label: "Quick or bulk", blurb: "Haiku. Lookups and simple jobs, fastest", model: "haiku", effort: "medium" },
  { id: "big", label: "Big refactor or research", blurb: "Fable. Migrations, architecture, deep research", model: "fable", effort: "medium" },
];

/** "Don't pick for me": the model and effort the agent would have started with anyway. */
export const KEEP = "keep";

const KEY = "kvistcode.workType";

export function readWorkChoice(): string | null {
  const v = storage.get(KEY);
  return v === KEEP || WORK_TYPES.some((w) => w.id === v) ? v : null;
}

export function saveWorkChoice(choice: string) {
  storage.set(KEY, choice);
}

/**
 * What a launch starts on when nothing was picked yet. `remembered` is whether the computer already has
 * a Claude model or effort of the user's own (null = an older server that can't say): they keep it, so
 * nothing changes silently; a fresh install gets the recommended Opus at medium.
 */
export function defaultWorkChoice(remembered: boolean | null): string {
  return remembered === false ? WORK_TYPES[0].id : KEEP;
}

/** The pick in effect: the last one if it is still on offer, else the default. */
export function resolveWorkChoice(stored: string | null, remembered: boolean | null): string {
  return stored ?? defaultWorkChoice(remembered);
}

/** The model and effort to start a new agent with (Claude only; nothing otherwise). */
export function choicesFor(provider: string, choice: string): Record<string, string> {
  if (provider !== "claude" || choice === KEEP) return {};
  const w = WORK_TYPES.find((x) => x.id === choice);
  return w ? { model: w.model, effort: w.effort } : {};
}

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

/** A short "good for" line for a choice Claude Code gave no description for (Claude agents only). */
export function choiceHint(agent: Pick<Agent, "provider">, option: Pick<ConfigOption, "id">, value: string): string | null {
  if (agent.provider !== "claude") return null;
  if (option.id === "effort") return EFFORT_HINTS[value] ?? null;
  if (option.id === "model") return MODEL_HINTS[value] ?? null;
  return null;
}

/** A line under a Claude option's choices that says when to use it. */
export function optionNote(agent: Pick<Agent, "provider">, option: Pick<ConfigOption, "id">): string | null {
  if (agent.provider !== "claude") return null;
  if (option.id === "effort") return "Before a bigger model, try one effort level higher. Past High, a bigger model is often the better buy.";
  if (option.id === "model") return "Switch at a break: a new model re-reads the whole conversation once.";
  return null;
}

/** Conversation size (tokens) above which changing the model is worth a word first. */
export const SWITCH_NOTE_TOKENS = 100_000;

/** Whether picking `value` should first ask: a Claude model change on a long conversation. */
export function switchNeedsNote(agent: Pick<Agent, "provider" | "contextUsed">, option: Pick<ConfigOption, "id" | "currentValue">, value: string): boolean {
  return agent.provider === "claude" && option.id === "model" && value !== option.currentValue && (agent.contextUsed ?? 0) >= SWITCH_NOTE_TOKENS;
}
