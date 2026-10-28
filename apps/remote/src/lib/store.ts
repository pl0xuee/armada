import { useSyncExternalStore } from "react";
import type { Agent, AttentionReason, RemoteAccount, RemoteCustomAgent, Session, TimelineItem } from "./types";

export type Phase =
  /** Checking the stored token. */
  | "boot"
  /** No usable token: show the pairing screen. */
  | "unpaired"
  /** Paired; the main UI is shown (data may still be loading). */
  | "ready"
  /** Paired but the server can't be reached / refuses us for now. */
  | "blocked";

export type UnpairedReason = null | "revoked" | "invalid_link";

export type BlockedReason = "unreachable" | "rate_limited" | "error";

export type Connection = "connecting" | "live" | "reconnecting" | "offline";

export interface Timeline {
  status: "loading" | "ready" | "error";
  items: TimelineItem[];
  error: string | null;
  /** Possibly out of date (missed events); refetched next time it's opened. */
  stale: boolean;
}

/** A prompt the user sent that the server hasn't echoed back yet. */
export interface PendingPrompt {
  id: string;
  text: string;
  ts: number;
  failed: boolean;
  /** Last timeline seq when sent; the server's echo must be newer. */
  afterSeq: number;
}

export type ToastTone = "info" | "ok" | "warn" | "err";

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  body: string | null;
  agentId: string | null;
  reason: AttentionReason | null;
  /** ms; 0 = sticky until dismissed. */
  duration: number;
}

export interface State {
  phase: Phase;
  unpairedReason: UnpairedReason;
  blockedReason: BlockedReason | null;
  blockedMessage: string | null;
  session: Session | null;

  stateStatus: "idle" | "loading" | "ready" | "error";
  stateError: string | null;
  agents: Record<string, Agent>;
  accounts: Record<string, RemoteAccount>;
  customAgents: Record<string, RemoteCustomAgent>;
  timelines: Record<string, Timeline>;

  connection: Connection;
  /** When the connection last left the `live` state (for debouncing the banner). */
  disconnectedAt: number | null;

  /** requestId -> chosen optionId, shown until the server confirms. */
  resolving: Record<string, string>;
  pendingPrompts: Record<string, PendingPrompt[]>;
  /** In-flight actions keyed `cancel:<id>` / `resume:<id>`. */
  busy: Record<string, true>;
  toasts: Toast[];
}

export const initialState: State = {
  phase: "boot",
  unpairedReason: null,
  blockedReason: null,
  blockedMessage: null,
  session: null,
  stateStatus: "idle",
  stateError: null,
  agents: {},
  accounts: {},
  customAgents: {},
  timelines: {},
  connection: "connecting",
  disconnectedAt: null,
  resolving: {},
  pendingPrompts: {},
  busy: {},
  toasts: [],
};

type Listener = () => void;

let state: State = initialState;
const listeners = new Set<Listener>();

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Selector must return a stable reference (a slice of state or a primitive). */
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

// ---------------------------------------------------------------------------
// Pure helpers for timeline updates.

/** Insert or replace an item, keeping the list ordered by `seq`. */
export function upsertItem(items: TimelineItem[], item: TimelineItem): TimelineItem[] {
  const idx = items.findIndex((i) => i.id === item.id);
  if (idx >= 0) {
    if (items[idx] === item) return items;
    const next = items.slice();
    next[idx] = item;
    return next;
  }
  const next = items.slice();
  let at = next.length;
  while (at > 0 && next[at - 1].seq > item.seq) at--;
  next.splice(at, 0, item);
  return next;
}

export function applyDelta(
  items: TimelineItem[],
  itemId: string,
  field: "text" | "output",
  delta: string,
): TimelineItem[] {
  const idx = items.findIndex((i) => i.id === itemId);
  if (idx < 0) return items;
  const it = items[idx];
  let updated: TimelineItem | null = null;
  if (field === "output" && it.kind === "tool_call") {
    updated = { ...it, output: it.output + delta };
  } else if (field === "text" && (it.kind === "agent_message" || it.kind === "thought" || it.kind === "user_message")) {
    updated = { ...it, text: it.text + delta };
  }
  if (!updated) return items;
  const next = items.slice();
  next[idx] = updated;
  return next;
}

export function sortItems(items: TimelineItem[]): TimelineItem[] {
  return items.slice().sort((a, b) => a.seq - b.seq);
}
