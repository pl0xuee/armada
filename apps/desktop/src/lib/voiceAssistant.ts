// Pure state for the voice assistant panel. The Rust session (src-tauri/src/voice_assistant)
// emits `va-event`s; `reduceVa` folds them into what the panel shows.

export type VaPhase = "off" | "connecting" | "listening" | "thinking" | "speaking" | "error";

export interface VaCaption {
  role: "user" | "assistant";
  itemId: string;
  text: string;
  done: boolean;
}

export interface VaAction {
  id: string;
  kind: string;
  summary: string;
  agentId: string | null;
  ok: boolean;
}

/** A side effect the assistant wants to do; it runs only after the user confirms. */
export interface VaConfirm {
  id: string;
  kind: string;
  summary: string;
}

export type VaEvent =
  | { type: "state"; state: Exclude<VaPhase, "off">; message: string | null }
  | { type: "level"; input: number; output: number }
  | ({ type: "caption" } & VaCaption)
  | ({ type: "action" } & VaAction)
  | { type: "usage"; elapsedSecs: number; costUsd: number }
  | { type: "navigate"; view: string; agentId: string | null }
  | ({ type: "confirm_action" } & VaConfirm)
  | { type: "confirm_done"; id: string; status: "confirmed" | "cancelled" | "expired" }
  | { type: "notice"; message: string | null }
  | { type: "ended"; reason: string; error: boolean };

export interface VaState {
  phase: VaPhase;
  message: string | null;
  inputLevel: number;
  outputLevel: number;
  captions: VaCaption[];
  actions: VaAction[];
  elapsedSecs: number;
  costUsd: number;
  muted: boolean;
  /** A non-fatal message beside a live session (a transient API error, "Reconnected"). */
  notice: string | null;
  /** Actions waiting for the user's Confirm / Cancel. */
  confirms: VaConfirm[];
  /** Why the last session ended (shown until the panel is dismissed). */
  endedReason: string | null;
}

export const MAX_CAPTIONS = 4;
export const MAX_ACTIONS = 20;

export const initialVa: VaState = {
  phase: "off",
  message: null,
  inputLevel: 0,
  outputLevel: 0,
  captions: [],
  actions: [],
  elapsedSecs: 0,
  costUsd: 0,
  muted: false,
  notice: null,
  confirms: [],
  endedReason: null,
};

/** A fresh session: clears the previous one's captions and log. */
export function beginVa(): VaState {
  return { ...initialVa, phase: "connecting" };
}

export function reduceVa(s: VaState, e: VaEvent): VaState {
  switch (e.type) {
    case "state":
      // An error that arrives after the session ended must not resurrect the panel.
      if (s.phase === "off" && s.endedReason !== null) return s;
      return { ...s, phase: e.state, message: e.message };
    case "level":
      return { ...s, inputLevel: s.muted ? 0 : e.input, outputLevel: e.output };
    case "caption": {
      const { type: _t, ...cap } = e;
      void _t;
      const i = s.captions.findIndex((c) => c.itemId === cap.itemId && c.role === cap.role);
      const captions = i >= 0 ? s.captions.map((c, j) => (j === i ? cap : c)) : [...s.captions, cap];
      return { ...s, captions: captions.slice(-MAX_CAPTIONS) };
    }
    case "action": {
      const { type: _t, ...action } = e;
      void _t;
      return { ...s, actions: [...s.actions, action].slice(-MAX_ACTIONS) };
    }
    case "usage":
      return { ...s, elapsedSecs: e.elapsedSecs, costUsd: e.costUsd };
    case "navigate":
      return s;
    case "confirm_action": {
      if (!isLive(s)) return s;
      const { type: _t, ...c } = e;
      void _t;
      return s.confirms.some((x) => x.id === c.id) ? s : { ...s, confirms: [...s.confirms, c] };
    }
    case "confirm_done":
      return { ...s, confirms: s.confirms.filter((c) => c.id !== e.id) };
    case "notice":
      return isLive(s) ? { ...s, notice: e.message } : s;
    case "ended":
      return {
        ...s,
        notice: null,
        confirms: [],
        phase: e.error ? "error" : "off",
        message: e.error ? e.reason : null,
        endedReason: e.reason,
        inputLevel: 0,
        outputLevel: 0,
      };
  }
}

/** True while a session exists (connecting through speaking). A transient error is a
 * `notice` on a live phase, never the "error" phase, which only follows a real end. */
export function isLive(s: Pick<VaState, "phase">): boolean {
  return s.phase !== "off" && s.phase !== "error";
}

export function formatElapsed(secs: number): string {
  const m = Math.floor(secs / 60);
  const r = Math.max(0, Math.floor(secs % 60));
  return `${m}:${r.toString().padStart(2, "0")}`;
}

/** Cost estimates are small; keep cents visible. */
export function formatCost(usd: number): string {
  if (usd < 0.005) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export const PHASE_LABEL: Record<Exclude<VaPhase, "off">, string> = {
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking…",
  speaking: "Speaking",
  error: "Something went wrong",
};

export const VA_MODEL_DEFAULT = "gpt-realtime";
export const VA_DEFAULT_VOICES = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
];
export const VA_SHORTCUT = ["Shift", "A"] as const;
