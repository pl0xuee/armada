import type { WakeStatus } from "./types";

export const DEFAULT_WAKE_PHRASE = "Hey Kvistcode";
export const WAKE_PHRASE_MAX = 40;

/** The speech model the wake phrase listens with (about 75 MB). */
export const WAKE_MODEL = "tiny.en";

/**
 * Why a wake phrase can't be used, or null when it is fine. The same rules, in the same order and
 * words, as the core's check: the first failing one wins.
 */
export function wakePhraseProblem(phrase: string): string | null {
  const text = phrase.trim();
  if (text === "") return "Enter a wake phrase, like “Hey Kvistcode”.";
  if ([...text].length > WAKE_PHRASE_MAX) return `The wake phrase can be up to ${WAKE_PHRASE_MAX} characters.`;
  if (/[^\p{L}\s'’-]/u.test(text)) return "Use only words in the wake phrase.";
  const words = text.split(/\s+/).length;
  if (words < 2) return "Use at least two words, like “Hey Kvistcode”, so everyday talk doesn't start it.";
  if (words > 5) return "Use five words or fewer.";
  return null;
}

/** What the status line under the wake phrase setting shows. */
export interface WakeLine {
  kind: "listening" | "download" | "starting" | "info" | "error";
  text: string;
}

export function wakeLine(status: WakeStatus | null, wakeOn: boolean, assistantOn: boolean): WakeLine | null {
  if (!wakeOn) return null;
  if (!assistantOn) return { kind: "info", text: "Turn on the voice assistant to use a wake phrase." };
  if (!status) return null;
  switch (status.state) {
    case "listening":
      return { kind: "listening", text: `Listening for “${status.phrase}”` };
    case "needsModel":
      return { kind: "download", text: "Needs the small speech model (75 MB)." };
    case "starting":
      return { kind: "starting", text: "Starting…" };
    case "waiting":
      return { kind: "info", text: status.message ?? "Paused for now." };
    case "error":
      return { kind: "error", text: status.message ?? "The wake phrase stopped working." };
    case "off":
      return status.message ? { kind: "info", text: status.message } : null;
  }
}
