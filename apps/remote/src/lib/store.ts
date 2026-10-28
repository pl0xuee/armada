import { useSyncExternalStore } from "react";
import type { Agent, Attachment, AttentionReason, PermissionItem, PermissionMode, PromptTemplate, RemoteAccount, RemoteCustomAgent, Session, TimelineItem } from "./types";

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

/** "unavailable" = the server answered 503 (remote access off): retried automatically. */
export type BlockedReason = "unreachable" | "unavailable" | "misdirected" | "rate_limited" | "error";

/** "limited" = the event stream was refused (e.g. too many connections): we poll instead. */
export type Connection = "connecting" | "live" | "reconnecting" | "offline" | "limited";

export interface Timeline {
  status: "loading" | "ready" | "error";
  items: TimelineItem[];
  error: string | null;
  /** Possibly out of date (missed events); refetched next time it's opened. */
  stale: boolean;
  /** Older items exist on the server (only the tail is loaded). */
  hasMore?: boolean;
  /** Loading an older page. */
  loadingOlder?: boolean;
}

/** A prompt the user sent that the server hasn't echoed back yet. */
export interface PendingPrompt {
  id: string;
  text: string;
  ts: number;
  failed: boolean;
  /** The server accepted it; waiting for it to show up in the timeline or the queue. */
  sent: boolean;
  attachments: Attachment[];
  /** Idempotency-Key: a retry reuses it, so the server never runs the prompt twice. */
  key: string;
  /** Upload progress 0..1 while photos are being sent, else null. */
  progress: number | null;
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
  /** Optional button, e.g. Undo. */
  action?: { label: string; run: () => void };
}

export interface ConfirmRequest {
  title: string;
  body?: string;
  confirmLabel: string;
  destructive?: boolean;
  resolve: (ok: boolean) => void;
}

export interface State {
  phase: Phase;
  unpairedReason: UnpairedReason;
  blockedReason: BlockedReason | null;
  blockedMessage: string | null;
  session: Session | null;
  /** A read-only share link is shown on top of this device's own pairing (tab-only). */
  sharedView: boolean;

  stateStatus: "idle" | "loading" | "ready" | "error";
  stateError: string | null;
  agents: Record<string, Agent>;
  accounts: Record<string, RemoteAccount>;
  customAgents: Record<string, RemoteCustomAgent>;
  /** For starting agents (owner only): recent folders, templates, worktree default. */
  projects: string[];
  templates: PromptTemplate[];
  defaultWorktree: boolean;
  /** null = the server doesn't support choosing it. */
  defaultPermissionMode: PermissionMode | null;
  timelines: Record<string, Timeline>;

  connection: Connection;
  /** Server's explanation when the stream is refused (shown in the banner). */
  connectionNote: string | null;
  /** Pending approvals across agents (GET /api/permissions), by requestId. */
  permissions: Record<string, PermissionItem>;
  permissionsStatus: "idle" | "loading" | "ready" | "error";
  /** When the connection last left the `live` state (for debouncing the banner). */
  disconnectedAt: number | null;

  /** requestId -> chosen optionId, shown until the server confirms. */
  resolving: Record<string, string>;
  pendingPrompts: Record<string, PendingPrompt[]>;
  /** In-flight actions keyed `cancel:<id>` / `resume:<id>`. */
  busy: Record<string, true>;
  toasts: Toast[];
  /** The confirmation dialog being shown, if any. */
  confirm: ConfirmRequest | null;
}

export const initialState: State = {
  phase: "boot",
  unpairedReason: null,
  blockedReason: null,
  blockedMessage: null,
  session: null,
  sharedView: false,
  stateStatus: "idle",
  stateError: null,
  agents: {},
  accounts: {},
  customAgents: {},
  projects: [],
  templates: [],
  defaultWorktree: false,
  defaultPermissionMode: null,
  timelines: {},
  connection: "connecting",
  connectionNote: null,
  permissions: {},
  permissionsStatus: "idle",
  disconnectedAt: null,
  resolving: {},
  pendingPrompts: {},
  busy: {},
  toasts: [],
  confirm: null,
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
