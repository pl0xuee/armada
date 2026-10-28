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

export type VaEvent =
  | { type: "state"; state: Exclude<VaPhase, "off">; message: string | null }
  | { type: "level"; input: number; output: number }
  | ({ type: "caption" } & VaCaption)
  | ({ type: "action" } & VaAction)
  | { type: "usage"; elapsedSecs: number; costUsd: number }
  | { type: "navigate"; view: string; agentId: string | null }
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
    case "ended":
      return {
        ...s,
        phase: e.error ? "error" : "off",
        message: e.error ? e.reason : null,
        endedReason: e.reason,
        inputLevel: 0,
        outputLevel: 0,
      };
  }
}

/** True while a session exists (connecting through speaking). */
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
