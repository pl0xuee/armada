// What "Send now" on a queued message does, so the words on the button, its tooltip and the note
// afterwards always match what the backend will really do. It never stops the running turn:
// stopping is the separate, explicitly labelled "Stop & send".
import type { Agent, TimelineItem } from "./types";

/** `run`: the agent is idle, so it just runs. `deliver`: into the running turn. `front`: first in line. */
export type SendNowMode = "run" | "deliver" | "front";

export interface SendNowPlan {
  mode: SendNowMode;
  /** Button text and accessible name stem. */
  label: string;
  /** Tooltip. */
  hint: string;
  /** Shown after pressing it when the message could not go into the running turn (mode "front"). */
  note: { title: string; description: string } | null;
}

/** A slash command only works at the start of a turn, so it can't be delivered mid-turn. */
export function isSlashCommand(text: string): boolean {
  return text.trimStart().startsWith("/");
}

/**
 * @param busy the agent is mid-turn (working, starting or waiting on you)
 * @param name the agent's short name ("Claude")
 */
export function sendNowPlan(agent: Pick<Agent, "steerable">, text: string, busy: boolean, name: string): SendNowPlan {
  if (!busy) return { mode: "run", label: "Send now", hint: "Run this next", note: null };
  if (isSlashCommand(text)) {
    return {
      mode: "front",
      label: "Run next",
      hint: "Commands only work at the start of a turn: this goes first in line and runs when the current turn ends. Nothing is stopped.",
      note: {
        title: "First in line",
        description: `Commands only work at the start of a turn, so ${name} will run this as soon as it finishes the current turn.`,
      },
    };
  }
  if (agent.steerable) {
    return {
      mode: "deliver",
      label: "Send now",
      hint: `Add it to the running turn: ${name} reads it at its next step and keeps working. Nothing is stopped.`,
      note: null,
    };
  }
  return {
    mode: "front",
    label: "Run next",
    hint: `${name} can't take messages mid-turn here: this goes first in line and is read as soon as the current turn finishes. Nothing is stopped.`,
    note: {
      title: `${name} can't take messages mid-turn here`,
      description: "It's first in line and will be read as soon as the current turn finishes. Nothing was stopped.",
    },
  };
}

/**
 * Messages you sent while the agent was working that it hasn't answered yet: the trailing run of mid-turn
 * user messages with no agent output after them. The timeline notes them quietly ("read at its next step")
 * until the agent's next output arrives, since the agent gives no sign of when it actually read one.
 */
export function midTurnAwaiting(items: readonly TimelineItem[]): Set<string> {
  const ids = new Set<string>();
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user_message") {
      if (!it.midTurn) break;
      ids.add(it.id);
    } else if (
      it.kind === "agent_message" ||
      it.kind === "thought" ||
      it.kind === "tool_call" ||
      it.kind === "turn_summary"
    ) {
      break;
    }
  }
  return ids;
}
