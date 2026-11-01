/**
 * What Send does while the agent works, so the words on the screen always match what the server will do.
 * The desktop's behaviour (apps/desktop/src/lib/sendNow.ts, the Enter / "Queue until the turn ends" menu):
 * an agent that can take messages mid-turn reads a typed message at its next step; for the rest, and for
 * slash commands (which only work at the start of a turn), it is queued behind the turn. Stopping is its own,
 * confirmed "Stop & send".
 */
import { isSlashCommand } from "@shared/sendNow";
import type { Agent } from "./types";

export type BusySend = "deliver" | "queue";

export interface BusySendPlan {
  /** What to ask the server for; undefined while the agent is idle (it just runs). */
  mode: BusySend | undefined;
  /** One line under the box that says what will happen. */
  note: string | null;
  /** The reader may pick the other way (deliver <-> queue). */
  canToggle: boolean;
}

export function busySendPlan(
  agent: Pick<Agent, "steerable">,
  text: string,
  busy: boolean,
  /** What the reader picked for this message (null: the default). */
  chosen: BusySend | null = null,
): BusySendPlan {
  if (!busy) return { mode: undefined, note: null, canToggle: false };
  if (isSlashCommand(text)) return { mode: "queue", note: "Commands run after this turn.", canToggle: false };
  if (!agent.steerable) return { mode: "queue", note: "Runs after this turn.", canToggle: false };
  const mode = chosen ?? "deliver";
  return {
    mode,
    note: mode === "deliver" ? "Read at its next step." : "Waits for this turn to end.",
    canToggle: true,
  };
}
