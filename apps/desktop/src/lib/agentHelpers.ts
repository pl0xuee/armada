// The model and effort a Claude agent's helpers (Claude Code sub-agents) run on: the agent's own choice from the
// composer's Helpers menu, else the "Helper agents use" / "Helper effort" settings. Mirrors `subagents_for` in
// token_saver.rs, which writes what the agent's hook reads.
import type { Agent } from "./types";

type Own = Pick<Agent, "subagentModel" | "subagentEffort">;
type Setting = { subagentModel?: string | null; subagentEffort?: string | null };

/** What the helpers run on: a model alias / effort level, or null for "same as the agent" / "Claude decides". */
export function agentHelpers(agent: Own | undefined, setting: Setting | null | undefined) {
  const pick = (own: string | null | undefined, fallback: string | null | undefined, none: string) =>
    own == null || own === "" ? (fallback ?? null) : own === none ? null : own;
  return {
    model: pick(agent?.subagentModel, setting?.subagentModel, "same"),
    effort: pick(agent?.subagentEffort, setting?.subagentEffort, "auto"),
  };
}

/** The agent overrides the settings for its helpers. */
export function ownsHelpers(agent: Own | undefined): boolean {
  return !!agent?.subagentModel || !!agent?.subagentEffort;
}
