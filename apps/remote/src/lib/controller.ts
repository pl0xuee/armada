/**
 * App controller: owns the backend, the live-event connection and every
 * server round-trip. Components read state through `useStore` and call the
 * exported actions; nothing else talks to the network.
 *
 * Consistency model
 * - The event stream is the source of truth for changes. Every time it
 *   (re)opens we refetch `/api/state` and the timelines we care about, so
 *   anything missed while disconnected is recovered.
 * - Events that arrive while a snapshot is in flight are buffered and merged
 *   on top of it (`lib/timeline.ts`): upserts never regress a more complete
 *   snapshot item, and streamed text goes through the server's `offset`, so
 *   chunks are applied exactly once; a detected gap triggers a refetch.
 *
 * Pairing model (see `lib/auth.ts`): a token from a link is validated with
 * `/api/session` before it is stored, and a rejected link falls back to the
 * device's existing pairing instead of wiping it.
 */
import { ApiError, api, errorMessage, HttpBackend, newIdempotencyKey, type Backend } from "./api";
import { adoptValidatedToken, clearPairing, hasTokenParam, setShared, storedToken, takeLinkToken } from "./auth";
import { getRoute, navigate, notifyRouteChange } from "./router";
import { getState, initialState, setState, type Connection, type PendingPrompt, type Timeline, type Toast } from "./store";
import { coalesceDeltas, reconcilePending } from "./composerLogic";
import { purgeAllDrafts, purgeDraft } from "./drafts";
import { commitMessage, shipOutcome, throttledProgress } from "./outcomes";
import { loadLocalImage } from "./localImages";
import { applyConfigValue } from "./config";
import { applyDelta, mergeSnapshot, upsertItem, type BufferedEvent } from "./timeline";
import type {
  Agent,
  Attachment,
  AttentionEvent,
  CreateAgentRequest,
  PermissionItem,
  RemoteAccount,
  RemoteEvent,
  StateSnapshot,
  TimelineItem,
} from "./types";

let backend: Backend | null = null;
let connection: ConnectionHandle | null = null;
let generation = 0; // bumped on every (re)connect/unpair so late responses are discarded

type TokenSource = "candidate" | "stored" | "shared";
interface TokenRef {
  token: string;
  source: TokenSource;
}

/** The token the live session runs on (after validation). */
let current: TokenRef | null = null;
/** The token being tried (for "Try again" on the blocked screen). */
let attempting: TokenRef | null = null;

// ---------------------------------------------------------------------------
// Boot / pairing

export interface DevOverrides {
  backend?: Backend;
  /** Start on the pairing screen (mock deep link). */
  forceUnpaired?: "plain" | "revoked";
}

let devOverrides: DevOverrides = {};

export async function boot() {
  const link = takeLinkToken();
  window.addEventListener("hashchange", onHashChange);

  // The mock is only ever in dev, or in a measurement build made with
  // VITE_REMOTE_MOCK=1 (never shipped); regular builds drop it entirely.
  if (import.meta.env.DEV || import.meta.env.VITE_REMOTE_MOCK === "1") {
    const { resolveDevBackend } = await import("../mock/dev");
    const dev = await resolveDevBackend();
    if (dev) {
      devOverrides = dev;
      if (dev.forceUnpaired) {
        setState({ phase: "unpaired", unpairedReason: dev.forceUnpaired === "revoked" ? "revoked" : null });
        return;
      }
      await connect({ token: link.candidate ?? "dev-mock-token", source: "stored" });
      return;
    }
  }

  if (link.candidate) return connect({ token: link.candidate, source: "candidate" });
  const stored = storedToken();
  if (stored) {
    if (link.malformed) invalidLinkToast();
    return connect(stored);
  }
  setState({ phase: "unpaired", unpairedReason: link.malformed ? "invalid_link" : null });
}

/** A pairing link opened in a tab that already runs the app only changes the hash. */
function onHashChange() {
  if (!hasTokenParam(location.hash)) return;
  const link = takeLinkToken();
  notifyRouteChange();
  if (link.candidate) void connect({ token: link.candidate, source: "candidate" });
  else if (getState().phase === "ready") invalidLinkToast();
  else setState({ phase: "unpaired", unpairedReason: "invalid_link" });
}

function invalidLinkToast() {
  pushToast({
    tone: "warn",
    title: "That pairing link didn't work",
    body: "It may have expired. You're still using this device's existing pairing.",
    agentId: null,
    reason: null,
    duration: 7_000,
  });
}

/** Pair using a token entered on the pairing screen. */
export async function pairWithToken(token: string) {
  await connect({ token, source: "candidate" });
}

/** Retry from the "can't reach Armada" / rate-limited screens (stays on that screen until it works). */
export async function retryConnect() {
  const ref = attempting ?? current;
  if (ref) await connect(ref, true);
  else setState({ phase: "unpaired" });
}

async function connect(ref: TokenRef, quiet = false) {
  const gen = ++generation;
  attempting = ref;
  connection?.stop();
  connection = null;
  const b = devOverrides.backend ?? new HttpBackend(ref.token);
  if (!quiet) setState({ phase: "boot", blockedReason: null, blockedMessage: null });

  try {
    const session = await api.session(b);
    if (gen !== generation) return;
    if (!session || (session.scope !== "owner" && session.scope !== "viewer")) {
      throw new ApiError(502, null, "Armada sent a response this app couldn't read.");
    }
    // Only now is the token known to be good.
    const source: TokenSource = ref.source === "candidate" ? adoptValidatedToken(ref.token, session.scope) : ref.source;
    if (current && current.token !== ref.token) resetData(); // different identity: drop its data
    current = { token: ref.token, source };
    attempting = null;
    backend = b;
    setState({
      session,
      phase: "ready",
      unpairedReason: null,
      sharedView: source === "shared",
      stateStatus: getState().stateStatus === "ready" ? "ready" : "loading",
    });
    if (session.scope === "viewer" && session.agentId) {
      navigate({ name: "agent", agentId: session.agentId }, { replace: true });
    }
    connection = openConnection(b, gen);
  } catch (e) {
    if (gen !== generation) return;
    if (e instanceof ApiError && e.isUnauthorized) {
      tokenRejected(ref);
    } else if (e instanceof ApiError && e.isRateLimited) {
      setState({ phase: "blocked", blockedReason: "rate_limited", blockedMessage: e.message });
    } else {
      const unreachable = e instanceof ApiError && (e.isNetwork || e.status === 408);
      setState({
        phase: "blocked",
        blockedReason: unreachable
          ? "unreachable"
          : e instanceof ApiError && e.status === 503
            ? "unavailable"
            : e instanceof ApiError && e.status === 421
              ? "misdirected"
              : "error",
        blockedMessage: errorMessage(e),
      });
    }
  }
}

function disconnect() {
  generation++;
  connection?.stop();
  connection = null;
  backend = null;
}

/**
 * The server refused `ref`. Forget it where it was stored, and fall back to
 * the next token this device has (a bad link never costs the pairing).
 */
function tokenRejected(ref: TokenRef) {
  disconnect();
  if (ref.source === "stored") clearPairing(ref.token);
  if (ref.source === "shared") setShared(null);
  if (current?.token === ref.token) current = null;
  attempting = null;
  const fallback = storedToken();
  if (fallback && fallback.token !== ref.token) {
    pushToast({
      tone: "warn",
      title: ref.source === "candidate" ? "That pairing link didn't work" : "This shared link has expired",
      body: "Reconnected with this device's existing pairing.",
      agentId: null,
      reason: null,
      duration: 7_000,
    });
    void connect(fallback);
    return;
  }
  resetData();
  setState({ phase: "unpaired", unpairedReason: ref.source === "candidate" ? "invalid_link" : "revoked" });
  navigate({ name: "fleet" }, { replace: true });
}

/** Forget this device's pairing (the server isn't told; revoke it on the desktop). */
export function unpair() {
  disconnect();
  if (current?.source === "shared") setShared(null);
  else {
    clearPairing();
    purgeAllDrafts();
  }
  current = null;
  attempting = null;
  // A tab-only share link sits on top of the pairing: leaving it returns to the pairing.
  const fallback = storedToken();
  navigate({ name: "fleet" }, { replace: true });
  if (fallback) {
    void connect(fallback);
    return;
  }
  resetData();
  setState({ phase: "unpaired", unpairedReason: null });
  navigate({ name: "fleet" }, { replace: true });
}

/** Mid-session 401 (token revoked or expired). */
function onUnauthorized() {
  if (current) tokenRejected(current);
  else {
    disconnect();
    resetData();
    setState({ phase: "unpaired", unpairedReason: "revoked" });
  }
}

function resetData() {
  const { toasts } = getState();
  setState({ ...initialState, toasts: toasts.filter((t) => !t.agentId) });
  itemsInFlight.clear();
  itemBuffers.clear();
  for (const t of refetchTimers.values()) clearTimeout(t);
  refetchTimers.clear();
  lru.length = 0;
}

function handleAuthError(e: unknown): boolean {
  if (e instanceof ApiError && e.isUnauthorized) {
    onUnauthorized();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Live events connection

interface ConnectionHandle {
  stop(): void;
  /** Called when the page becomes visible again or the network comes back. */
  nudge(reason: "visible" | "online"): void;
}

const WATCHDOG_MS = 50_000; // server heartbeats every 20 s
const STALE_AFTER_HIDDEN_MS = 25_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const STATE_FALLBACK_MS = 1_500;

function backoff(attempt: number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  // "Equal jitter": never hammer, never wait the full ceiling in lockstep with other clients.
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

function setConnection(next: Connection, note?: string | null) {
  const s = getState();
  const connectionNote = next === "live" ? null : note === undefined ? s.connectionNote : note;
  if (s.connection === next && s.connectionNote === connectionNote) return;
  setState({
    connection: next,
    connectionNote,
    disconnectedAt: next === "live" ? null : (s.disconnectedAt ?? Date.now()),
  });
}

/** While the stream is down (refused, or reconnecting), poll this often. */
const POLL_MS = 10_000;

function openConnection(b: Backend, gen: number): ConnectionHandle {
  let stopped = false;
  let controller: AbortController | null = null;
  let attempt = 0;
  let everOpened = false;
  let lastActivity = Date.now();
  let wake: (() => void) | null = null;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        wake = null;
        resolve();
      }
      wake = done;
    });

  const alive = () => !stopped && gen === generation;

  // If the stream is slow to open (or blocked by a proxy), don't leave the UI empty.
  const fallback = setTimeout(() => {
    if (alive() && !everOpened) void resync();
  }, STATE_FALLBACK_MS);

  // Without live events the view would go stale: poll state, approvals and the
  // open agent (only if it changed) until the stream is back.
  const poller = setInterval(() => {
    if (!alive() || !navigator.onLine || document.visibilityState !== "visible") return;
    const c = getState().connection;
    if (c === "limited" || c === "reconnecting") void resync();
  }, POLL_MS);

  const watchdog = setInterval(() => {
    if (controller && everOpened && getState().connection === "live" && Date.now() - lastActivity > WATCHDOG_MS) {
      controller.abort(); // stalled: the loop reconnects and resyncs
    }
  }, 5_000);

  const onOffline = () => {
    setConnection("offline");
    controller?.abort();
  };
  const onOnline = () => handle.nudge("online");
  const onVisibility = () => {
    if (document.visibilityState === "visible") handle.nudge("visible");
  };
  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisibility);

  const loop = async () => {
    while (alive()) {
      if (!navigator.onLine) {
        setConnection("offline");
        await sleep(60_000); // woken early by the `online` event
        continue;
      }
      // Only the very first attempt is "connecting"; after any failure we stay
      // "reconnecting" so the banner's debounce isn't reset by each retry.
      setConnection(everOpened || attempt > 0 ? "reconnecting" : "connecting");
      controller = new AbortController();
      let opened = false;
      try {
        await b.stream({
          signal: controller.signal,
          onOpen: () => {
            if (!alive()) return;
            opened = true;
            everOpened = true;
            attempt = 0;
            lastActivity = Date.now();
            setConnection("live");
            void resync();
          },
          onMessage: (data) => {
            if (alive()) enqueueEvent(data);
          },
          onActivity: () => {
            lastActivity = Date.now();
          },
        });
      } catch (e) {
        if (!alive()) return;
        if (e instanceof ApiError) {
          if (e.isUnauthorized) {
            onUnauthorized();
            return;
          }
          if (e.isRateLimited) {
            // Too many open streams for this device/link: say so, poll instead,
            // and try the stream again much later.
            attempt = Math.max(attempt, 5);
            setConnection("limited", e.message);
            void resync();
          } else if (e.serverMessage) {
            setConnection("reconnecting", e.message);
          }
        }
      } finally {
        controller = null;
      }
      if (!alive()) return;
      if (getState().connection !== "limited") setConnection(navigator.onLine ? "reconnecting" : "offline");
      // A stream that was healthy and then dropped reconnects almost at once;
      // repeated failures back off exponentially.
      await sleep(opened ? 250 + Math.random() * 750 : backoff(attempt++));
    }
  };

  const handle: ConnectionHandle = {
    stop() {
      stopped = true;
      clearTimeout(fallback);
      clearInterval(watchdog);
      clearInterval(poller);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibility);
      controller?.abort();
      wake?.();
    },
    nudge(reason) {
      if (!alive()) return;
      const quiet = Date.now() - lastActivity;
      if (controller && getState().connection === "live" && quiet < STALE_AFTER_HIDDEN_MS) {
        // The stream stayed healthy, so nothing was missed (if the server had to
        // drop events it sends `resync`): no refetch needed.
        void reason;
        return;
      }
      attempt = 0;
      controller?.abort();
      wake?.();
    },
  };

  void loop();
  return handle;
}

// ---------------------------------------------------------------------------
// Snapshots

let stateInFlight = false;
let stateAgain = false;
/** Agent events seen while `/api/state` is in flight, re-applied on top of the snapshot. */
let stateJournal: { updated: Map<string, Agent>; removed: Set<string> } | null = null;

const itemsInFlight = new Map<string, boolean>(); // agentId -> refetch again when done
/** Events for an agent received while its timeline fetch is in flight. */
const itemBuffers = new Map<string, BufferedEvent[]>();
/** Debounced refetches after a streaming gap. */
const refetchTimers = new Map<string, ReturnType<typeof setTimeout>>();
const gapRefetches = new Map<string, number[]>();
const lru: string[] = [];
const TIMELINE_CACHE = 12;

let resyncing = false;
let resyncAgain = false;

/** Refetch state and the timelines that are on screen or needed by the inbox. */
export async function resync() {
  if (resyncing) {
    resyncAgain = true;
    return;
  }
  resyncing = true;
  try {
    await refreshState();
    // Events may have been missed (lost stream, `resync`, polling), and item
    // changes don't necessarily touch the agent's timestamps, so every cached
    // timeline is stale. The open one refetches its tail now (cheap: 200 items,
    // merged by seq); the others when they're opened.
    setState((s) => {
      const timelines: Record<string, Timeline> = {};
      for (const [id, t] of Object.entries(s.timelines)) timelines[id] = t.status === "ready" ? { ...t, stale: true } : t;
      return { timelines };
    });
    const route = getRoute();
    if (route.name === "agent") ensureTimeline(route.agentId);
    void loadPermissions();
  } finally {
    resyncing = false;
    if (resyncAgain) {
      resyncAgain = false;
      void resync();
    }
  }
}

function agentRecency(a: Agent) {
  return Math.max(a.updatedAt || 0, a.lastActivityAt || 0);
}

export async function refreshState() {
  const b = backend;
  if (!b) return;
  if (stateInFlight) {
    stateAgain = true;
    return;
  }
  stateInFlight = true;
  stateJournal = { updated: new Map(), removed: new Set() };
  const gen = generation;
  if (getState().stateStatus !== "ready") setState({ stateStatus: "loading", stateError: null });
  try {
    const snap = (await api.state(b)) as StateSnapshot | null;
    if (gen !== generation) return;
    if (!snap || !Array.isArray(snap.agents) || !Array.isArray(snap.accounts)) {
      throw new ApiError(502, null, "Armada sent a response this app couldn't read.");
    }
    const agents: Record<string, Agent> = {};
    for (const a of snap.agents) if (a && typeof a.id === "string") agents[a.id] = a;
    for (const [id, a] of stateJournal.updated) {
      const snapA = agents[id];
      if (!snapA || agentRecency(a) >= agentRecency(snapA)) agents[id] = a;
    }
    for (const id of stateJournal.removed) delete agents[id];

    const accounts = Object.fromEntries(snap.accounts.filter((a) => a && a.id).map((a) => [a.id, a]));
    const customAgents = Object.fromEntries((snap.customAgents ?? []).filter((c) => c && c.id).map((c) => [c.id, c]));
    const projects = Array.isArray(snap.projects) ? snap.projects.filter((p) => typeof p === "string" && p) : [];
    const templates = Array.isArray(snap.templates) ? snap.templates.filter((t) => t && t.id && typeof t.text === "string") : [];
    setState((s) => {
      const timelines = { ...s.timelines };
      for (const id of Object.keys(timelines)) if (!agents[id]) delete timelines[id];
      return {
        agents,
        accounts,
        customAgents,
        projects,
        templates,
        defaultWorktree: snap.defaultWorktree === true,
        defaultPermissionMode: snap.defaultPermissionMode === "auto" || snap.defaultPermissionMode === "ask" ? snap.defaultPermissionMode : null,
        timelines,
        stateStatus: "ready",
        stateError: null,
      };
    });
    for (const a of Object.values(agents)) reconcile(a.id, []);
  } catch (e) {
    if (gen !== generation) return;
    if (handleAuthError(e)) return;
    if (getState().stateStatus !== "ready") setState({ stateStatus: "error", stateError: errorMessage(e) });
  } finally {
    stateJournal = null;
    stateInFlight = false;
    if (stateAgain && gen === generation) {
      stateAgain = false;
      await refreshState();
    }
  }
}

/** Retry button on the fleet error state. */
export function retryState() {
  void resync();
}

function touchLru(agentId: string) {
  const i = lru.indexOf(agentId);
  if (i >= 0) lru.splice(i, 1);
  lru.push(agentId);
  if (lru.length <= TIMELINE_CACHE) return;
  const s = getState();
  const route = getRoute();
  const keep = (id: string) =>
    (route.name === "agent" && route.agentId === id) || (s.agents[id]?.pendingPermissions ?? 0) > 0;
  const evict = lru.filter((id) => !keep(id)).slice(0, lru.length - TIMELINE_CACHE);
  if (!evict.length) return;
  for (const id of evict) lru.splice(lru.indexOf(id), 1);
  setState((st) => {
    const timelines = { ...st.timelines };
    for (const id of evict) delete timelines[id];
    return { timelines };
  });
}

/** Make sure an agent's timeline is loaded (or refreshed if stale). */
export function ensureTimeline(agentId: string) {
  const t = getState().timelines[agentId];
  if (!t || t.stale || t.status === "error") void loadTimeline(agentId);
  else touchLru(agentId);
}

function setTimeline(agentId: string, t: Timeline) {
  setState((s) => ({ timelines: { ...s.timelines, [agentId]: t } }));
}

export async function loadTimeline(agentId: string) {
  const b = backend;
  if (!b) return;
  if (itemsInFlight.has(agentId)) {
    itemsInFlight.set(agentId, true);
    return;
  }
  itemsInFlight.set(agentId, false);
  itemBuffers.set(agentId, []);
  const gen = generation;
  const existing = getState().timelines[agentId];
  if (!existing || existing.status === "error") {
    setTimeline(agentId, { status: "loading", items: existing?.items ?? [], error: null, stale: false });
  }
  try {
    // The tail only; older pages load when the reader scrolls up.
    const raw = await api.items(b, agentId, PAGE_SIZE);
    if (gen !== generation) return;
    if (!Array.isArray(raw)) throw new ApiError(502, null, "Armada sent a response this app couldn't read.");
    const snapshot = raw.filter((i) => i && typeof i.id === "string" && typeof i.kind === "string");
    const merged = mergeSnapshot(snapshot, itemBuffers.get(agentId) ?? []);
    const { gap } = merged;
    // Keep older pages already loaded (the tail refetch doesn't include them).
    const minSeq = snapshot.length ? snapshot[0].seq : Infinity;
    const prev = getState().timelines[agentId];
    const older = prev && snapshot.length ? prev.items.filter((i) => i.seq < minSeq) : [];
    const items = older.length ? [...older, ...merged.items] : merged.items;
    const hasMore = older.length ? (prev?.hasMore ?? false) : raw.length >= PAGE_SIZE;
    setTimeline(agentId, { status: "ready", items, error: null, stale: false, hasMore });
    if (gap) scheduleRefetch(agentId);
    reconcile(agentId, items);
    touchLru(agentId);
  } catch (e) {
    if (gen !== generation) return;
    if (handleAuthError(e)) return;
    const cur = getState().timelines[agentId];
    if (cur && cur.status === "ready") {
      // Keep showing what we have, marked stale with the reason (retried on the next resync).
      setTimeline(agentId, { ...cur, stale: true, error: errorMessage(e) });
    } else {
      const message = e instanceof ApiError && e.status === 404 ? "This agent no longer exists." : errorMessage(e);
      setTimeline(agentId, { status: "error", items: cur?.items ?? [], error: message, stale: false });
    }
  } finally {
    itemBuffers.delete(agentId);
    const again = itemsInFlight.get(agentId);
    itemsInFlight.delete(agentId);
    if (again && gen === generation) void loadTimeline(agentId);
  }
}

/** Items per page (the server caps a page at 1000). */
const PAGE_SIZE = 200;

/** Load the page before the oldest loaded item (scrolling up to the top). */
export async function loadOlder(agentId: string) {
  const b = backend;
  const t = getState().timelines[agentId];
  if (!b || !t || t.status !== "ready" || !t.hasMore || t.loadingOlder || !t.items.length) return;
  const before = t.items[0].seq;
  const gen = generation;
  setTimeline(agentId, { ...t, loadingOlder: true });
  try {
    const raw = await api.items(b, agentId, PAGE_SIZE, before);
    if (gen !== generation) return;
    if (!Array.isArray(raw)) throw new ApiError(502, null, "Armada sent a response this app couldn't read.");
    // Older servers ignore paging and send everything: keep only what's older.
    const page = raw.filter((i) => i && typeof i.id === "string" && i.seq < before).sort((x, y) => x.seq - y.seq);
    const cur = getState().timelines[agentId];
    if (!cur) return;
    const known = new Set(cur.items.map((i) => i.id));
    const items = [...page.filter((i) => !known.has(i.id)), ...cur.items];
    setTimeline(agentId, { ...cur, items, loadingOlder: false, hasMore: raw.length >= PAGE_SIZE && page.length > 0 });
  } catch (e) {
    if (gen !== generation || handleAuthError(e)) return;
    const cur = getState().timelines[agentId];
    if (cur) setTimeline(agentId, { ...cur, loadingOlder: false });
    toastError("Couldn't load earlier messages", e);
  }
}

const GAP_DEBOUNCE_MS = 250;
const GAP_LIMIT = 4; // refetches per agent per GAP_WINDOW_MS
const GAP_WINDOW_MS = 10_000;

/**
 * Our copy of a streamed field is missing text: refetch it (debounced, and
 * rate-limited so a misbehaving stream can't cause a refetch storm; the
 * server's final upsert of every stream heals any remaining gap).
 */
function scheduleRefetch(agentId: string) {
  if (refetchTimers.has(agentId)) return;
  const now = Date.now();
  const recent = (gapRefetches.get(agentId) ?? []).filter((t) => now - t < GAP_WINDOW_MS);
  if (recent.length >= GAP_LIMIT) return;
  recent.push(now);
  gapRefetches.set(agentId, recent);
  refetchTimers.set(
    agentId,
    setTimeout(() => {
      refetchTimers.delete(agentId);
      void loadTimeline(agentId);
    }, GAP_DEBOUNCE_MS),
  );
}

let permsInFlight = false;
let permsAgain = false;
/** Approval events seen while /api/permissions is in flight (latest per request). */
let permsJournal: Map<string, PermissionItem> | null = null;
let permsTimer: ReturnType<typeof setTimeout> | null = null;

/** Load every pending approval (one request) for the inbox and badges. */
export async function loadPermissions() {
  const b = backend;
  if (!b || getState().session?.scope !== "owner") return;
  if (permsInFlight) {
    permsAgain = true;
    return;
  }
  permsInFlight = true;
  permsJournal = new Map();
  const gen = generation;
  if (getState().permissionsStatus !== "ready") setState({ permissionsStatus: "loading" });
  try {
    const raw = await api.permissions(b);
    if (gen !== generation) return;
    if (!Array.isArray(raw)) throw new ApiError(502, null, "Armada sent a response this app couldn't read.");
    const permissions: Record<string, PermissionItem> = {};
    for (const it of raw) if (it && it.kind === "permission" && it.resolution === null) permissions[it.requestId] = it;
    for (const [id, it] of permsJournal) {
      if (it.resolution === null) permissions[id] = it;
      else delete permissions[id];
    }
    setState({ permissions, permissionsStatus: "ready" });
  } catch (e) {
    if (gen !== generation) return;
    if (handleAuthError(e)) return;
    if (getState().permissionsStatus !== "ready") setState({ permissionsStatus: "error" });
  } finally {
    permsJournal = null;
    permsInFlight = false;
    if (permsAgain && gen === generation) {
      permsAgain = false;
      void loadPermissions();
    }
  }
}

function schedulePermissions() {
  if (permsTimer) return;
  permsTimer = setTimeout(() => {
    permsTimer = null;
    void loadPermissions();
  }, 400);
}

/** Keep the approvals list in step with timeline events. */
function notePermission(item: PermissionItem) {
  permsJournal?.set(item.requestId, item);
  setState((s) => {
    const has = !!s.permissions[item.requestId];
    if (item.resolution === null) return { permissions: { ...s.permissions, [item.requestId]: item } };
    if (!has) return {};
    const permissions = { ...s.permissions };
    delete permissions[item.requestId];
    return { permissions };
  });
}

// ---------------------------------------------------------------------------
// Events

/**
 * Events are applied in batches, once per animation frame: a burst of
 * streamed text causes one store update and one render instead of one per
 * chunk. While the page is hidden there are no frames, so a timer flushes.
 */
let eventQueue: string[] = [];
let flushScheduled = false;
const HIDDEN_FLUSH_MS = 250;

function enqueueEvent(raw: string) {
  eventQueue.push(raw);
  if (flushScheduled) return;
  flushScheduled = true;
  if (typeof requestAnimationFrame === "function" && document.visibilityState === "visible") {
    requestAnimationFrame(flushEvents);
  } else {
    setTimeout(flushEvents, HIDDEN_FLUSH_MS);
  }
}

function flushEvents() {
  flushScheduled = false;
  const raw = eventQueue;
  eventQueue = [];
  const parsed: RemoteEvent[] = [];
  for (const r of raw) {
    try {
      const ev = JSON.parse(r) as RemoteEvent;
      if (ev && typeof ev === "object" && typeof ev.type === "string") parsed.push(ev);
    } catch {
      // ignore malformed events
    }
  }
  for (const ev of coalesceDeltas(parsed)) handleEvent(ev);
}

function handleEvent(ev: RemoteEvent) {
  switch (ev.type) {
    case "agent_updated": {
      const agent = ev.agent;
      if (!agent || typeof agent.id !== "string") return;
      stateJournal?.updated.set(agent.id, agent);
      stateJournal?.removed.delete(agent.id);
      const prev = getState().agents[agent.id];
      setState((s) => ({ agents: { ...s.agents, [agent.id]: agent } }));
      reconcile(agent.id, []);
      if (agent.pendingPermissions > 0 && (prev?.pendingPermissions ?? 0) < agent.pendingPermissions) {
        if (getState().session?.scope === "owner") schedulePermissions();
      }
      return;
    }
    case "agent_removed": {
      const id = ev.agentId;
      stateJournal?.removed.add(id);
      stateJournal?.updated.delete(id);
      setState((s) => {
        if (!s.agents[id] && !s.timelines[id]) return {};
        const agents = { ...s.agents };
        const timelines = { ...s.timelines };
        const pendingPrompts = { ...s.pendingPrompts };
        delete agents[id];
        delete timelines[id];
        delete pendingPrompts[id];
        purgeDraft(id);
        let permissions = s.permissions;
        for (const [rid, p] of Object.entries(s.permissions)) {
          if (p.agentId !== id) continue;
          if (permissions === s.permissions) permissions = { ...s.permissions };
          delete permissions[rid];
        }
        return { agents, timelines, pendingPrompts, permissions };
      });
      return;
    }
    case "item_upserted": {
      const item = ev.item;
      if (!item || typeof item.id !== "string") return;
      itemBuffers.get(item.agentId)?.push({ type: "item_upserted", item });
      if (item.kind === "permission" && getState().session?.scope === "owner") notePermission(item);
      const t = getState().timelines[item.agentId];
      if (t && t.status !== "error") {
        const items = upsertItem(t.items, item);
        setTimeline(item.agentId, { ...t, items });
        reconcile(item.agentId, [item]);
      }
      return;
    }
    case "text_delta": {
      if (typeof ev.delta !== "string" || typeof ev.offset !== "number") return;
      const buffer = itemBuffers.get(ev.agentId);
      buffer?.push(ev);
      const t = getState().timelines[ev.agentId];
      if (!t || t.status === "error") return;
      const r = applyDelta(t.items, ev);
      if (r.items !== t.items) setTimeline(ev.agentId, { ...t, items: r.items });
      // While a fetch is in flight the buffered copy is reconciled with the snapshot instead.
      if (r.outcome === "gap" && !buffer && t.status === "ready") scheduleRefetch(ev.agentId);
      return;
    }
    case "attention":
      onAttention(ev);
      return;
    case "account_updated": {
      const a = toRemoteAccount(ev.account);
      if (a) setState((s) => ({ accounts: { ...s.accounts, [a.id]: a } }));
      return;
    }
    case "account_removed":
      setState((s) => {
        if (!s.accounts[ev.accountId]) return {};
        const accounts = { ...s.accounts };
        delete accounts[ev.accountId];
        return { accounts };
      });
      return;
    case "resync":
      void resync();
      return;
    default:
      // Unknown event types from a newer server are ignored on purpose.
      return;
  }
}

/** Map the full desktop Account (account_updated) to the remote's account shape. */
export function toRemoteAccount(a: unknown): RemoteAccount | null {
  if (!a || typeof a !== "object") return null;
  const x = a as { id?: unknown; name?: unknown; provider?: unknown; color?: unknown; status?: { label?: unknown; loggedIn?: unknown; error?: unknown } | null };
  if (typeof x.id !== "string" || typeof x.name !== "string" || typeof x.provider !== "string") return null;
  const st = x.status ?? null;
  return {
    id: x.id,
    name: x.name,
    provider: x.provider as RemoteAccount["provider"],
    color: typeof x.color === "string" ? x.color : "#7D8B99",
    label: st && typeof st.label === "string" ? st.label : null,
    loggedIn: st && typeof st.loggedIn === "boolean" ? st.loggedIn : null,
    error: st && typeof st.error === "string" ? st.error : null,
  };
}

/** Drop optimistic state the server has now confirmed. */
function reconcile(agentId: string, items: TimelineItem[]) {
  const s = getState();
  let resolving = s.resolving;
  for (const it of items) {
    if (it.kind === "permission" && it.resolution !== null && resolving[it.requestId]) {
      if (resolving === s.resolving) resolving = { ...resolving };
      delete resolving[it.requestId];
    }
  }
  const before = s.pendingPrompts[agentId];
  const pending = before?.length ? reconcilePending(before, items, s.agents[agentId]?.queue) : before;
  if (resolving !== s.resolving || pending !== s.pendingPrompts[agentId]) {
    setState((st) => ({
      resolving,
      pendingPrompts: pending === st.pendingPrompts[agentId] ? st.pendingPrompts : { ...st.pendingPrompts, [agentId]: pending },
    }));
  }
}

// ---------------------------------------------------------------------------
// Attention + toasts

let toastSeq = 0;
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function pushToast(t: Omit<Toast, "id">): string {
  const id = `t${++toastSeq}`;
  setState((s) => {
    // Collapse repeats for the same agent + reason instead of stacking them.
    const rest = s.toasts.filter((x) => !(t.agentId && x.agentId === t.agentId && x.reason === t.reason));
    for (const x of s.toasts) if (!rest.includes(x)) clearTimer(x.id);
    return { toasts: [...rest, { ...t, id }].slice(-3) };
  });
  if (t.duration > 0) toastTimers.set(id, setTimeout(() => dismissToast(id), t.duration));
  return id;
}

function clearTimer(id: string) {
  const timer = toastTimers.get(id);
  if (timer) clearTimeout(timer);
  toastTimers.delete(id);
}

export function dismissToast(id: string) {
  clearTimer(id);
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

/** Pause auto-dismiss while the user is touching a toast. */
export function holdToast(id: string, hold: boolean) {
  if (hold) clearTimer(id);
  else if (!toastTimers.has(id)) toastTimers.set(id, setTimeout(() => dismissToast(id), 4_000));
}

export function toastError(title: string, e: unknown) {
  pushToast({ tone: "err", title, body: errorMessage(e), agentId: null, reason: null, duration: 6_000 });
}

export function vibrate(pattern: number | number[]) {
  try {
    // Browsers ignore (and log) vibration before the user has interacted with the page.
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    navigator.vibrate?.(pattern);
  } catch {
    // Unsupported (iOS) or blocked: haptics are best-effort.
  }
}

function onAttention(ev: AttentionEvent) {
  if (ev.reason === "permission") vibrate([35, 60, 35]);
  const route = getRoute();
  const watching =
    route.name === "agent" && route.agentId === ev.agentId && document.visibilityState === "visible";
  if (watching) return; // the timeline already shows it
  pushToast({
    tone: ev.reason === "permission" ? "warn" : ev.reason === "done" ? "ok" : "err",
    title: ev.title,
    body: ev.body || null,
    agentId: ev.agentId,
    reason: ev.reason,
    duration: ev.reason === "permission" ? 10_000 : 6_000,
  });
}

// ---------------------------------------------------------------------------
// Owner actions

function requireBackend(): Backend {
  if (!backend) throw new ApiError(0, null);
  return backend;
}

export async function respondToPermission(agentId: string, requestId: string, optionId: string): Promise<boolean> {
  const s = getState();
  if (s.resolving[requestId]) return false;
  setState((st) => ({ resolving: { ...st.resolving, [requestId]: optionId } }));
  vibrate(12);
  try {
    await api.permission(requireBackend(), agentId, requestId, optionId);
    // Reflect the answer locally right away; the server's upsert confirms it.
    const t = getState().timelines[agentId];
    if (t) {
      const items = t.items.map((i) =>
        i.kind === "permission" && i.requestId === requestId && i.resolution === null ? { ...i, resolution: optionId } : i,
      );
      setTimeline(agentId, { ...t, items });
    }
    // The agent's `pendingPermissions` is the server's to update (via
    // `agent_updated`); counts are derived from the approvals list meanwhile.
    setState((st) => {
      const resolving = { ...st.resolving };
      delete resolving[requestId];
      const permissions = { ...st.permissions };
      delete permissions[requestId];
      return { resolving, permissions };
    });
    return true;
  } catch (e) {
    setState((st) => {
      const resolving = { ...st.resolving };
      delete resolving[requestId];
      return { resolving };
    });
    if (handleAuthError(e)) return false;
    if (e instanceof ApiError && (e.status === 404 || e.status === 409)) {
      pushToast({
        tone: "info",
        title: "Request no longer pending",
        body: "It was answered elsewhere or the agent moved on.",
        agentId: null,
        reason: null,
        duration: 5_000,
      });
      void loadPermissions();
      if (getState().timelines[agentId]) void loadTimeline(agentId);
      void refreshState();
    } else {
      toastError("Couldn't send your answer", e);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Undoable answers (swipe-to-approve): sent after a 5 s grace period.

const UNDO_MS = 5_000;
const deferredAnswers = new Map<string, { agentId: string; optionId: string; timer: ReturnType<typeof setTimeout> }>();

/** Answer after UNDO_MS unless undone; the card hides right away. */
export function respondWithUndo(agentId: string, requestId: string, optionId: string, label: string, detail: string | null) {
  if (getState().resolving[requestId] || deferredAnswers.has(requestId)) return;
  setState((s) => ({ resolving: { ...s.resolving, [requestId]: optionId } }));
  vibrate(12);
  const timer = setTimeout(() => flushAnswer(requestId), UNDO_MS);
  deferredAnswers.set(requestId, { agentId, optionId, timer });
  pushToast({
    tone: "info",
    title: label,
    body: detail,
    agentId: null,
    reason: null,
    duration: UNDO_MS,
    action: { label: "Undo", run: () => undoAnswer(requestId) },
  });
}

function undoAnswer(requestId: string) {
  const d = deferredAnswers.get(requestId);
  if (!d) return;
  clearTimeout(d.timer);
  deferredAnswers.delete(requestId);
  setState((s) => {
    const resolving = { ...s.resolving };
    delete resolving[requestId];
    return { resolving };
  });
}

function flushAnswer(requestId: string) {
  const d = deferredAnswers.get(requestId);
  if (!d) return;
  undoAnswer(requestId);
  void respondToPermission(d.agentId, requestId, d.optionId);
}

/** Leaving the app sends pending answers now instead of losing them. */
function flushAllAnswers() {
  for (const id of [...deferredAnswers.keys()]) flushAnswer(id);
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAllAnswers();
  });
  window.addEventListener("pagehide", flushAllAnswers);
}

let promptSeq = 0;

function patchPending(agentId: string, id: string, patch: Partial<PendingPrompt>) {
  setState((s) => ({
    pendingPrompts: {
      ...s.pendingPrompts,
      [agentId]: (s.pendingPrompts[agentId] ?? []).map((p) => (p.id === id ? { ...p, ...patch } : p)),
    },
  }));
}

export async function sendPrompt(agentId: string, text: string, attachments: Attachment[] = [], retryOf?: string) {
  const body = text.trim();
  if (!body && !attachments.length) return;
  const t = getState().timelines[agentId];
  const afterSeq = t?.items.length ? t.items[t.items.length - 1].seq : -1;
  const id = retryOf ?? `p${++promptSeq}`;
  const previous = retryOf ? getState().pendingPrompts[agentId]?.find((p) => p.id === retryOf) : undefined;
  const key = previous?.key ?? newIdempotencyKey();
  const entry: PendingPrompt = { id, text: body, ts: Date.now(), failed: false, sent: false, afterSeq, attachments, key, progress: attachments.length ? 0 : null };
  setState((s) => {
    const list = (s.pendingPrompts[agentId] ?? []).filter((p) => p.id !== id);
    return { pendingPrompts: { ...s.pendingPrompts, [agentId]: [...list, entry] } };
  });
  try {
    const onProgress = attachments.length ? throttledProgress((progress) => patchPending(agentId, id, { progress })) : undefined;
    await api.prompt(requireBackend(), agentId, body, attachments, key, onProgress);
    patchPending(agentId, id, { sent: true, progress: null });
    // It may already be in the queue (agent busy) or the timeline.
    reconcile(agentId, getState().timelines[agentId]?.items ?? []);
  } catch (e) {
    patchPending(agentId, id, { failed: true, progress: null });
    if (!handleAuthError(e)) toastError("Message not sent", e);
  }
}

export function discardPrompt(agentId: string, id: string) {
  setState((s) => ({
    pendingPrompts: { ...s.pendingPrompts, [agentId]: (s.pendingPrompts[agentId] ?? []).filter((p) => p.id !== id) },
  }));
}

async function busyAction(key: string, title: string, run: () => Promise<void>) {
  if (getState().busy[key]) return;
  setState((s) => ({ busy: { ...s.busy, [key]: true } }));
  try {
    await run();
  } catch (e) {
    if (!handleAuthError(e)) toastError(title, e);
  } finally {
    setState((s) => {
      const busy = { ...s.busy };
      delete busy[key];
      return { busy };
    });
  }
}

export function cancelTurn(agentId: string) {
  vibrate(10);
  return busyAction(`cancel:${agentId}`, "Couldn't stop the agent", () => api.cancel(requireBackend(), agentId));
}

export function resumeAgent(agentId: string) {
  vibrate(10);
  return busyAction(`resume:${agentId}`, "Couldn't resume the agent", () => api.resume(requireBackend(), agentId));
}

/** Kill the agent's process (it can be resumed later). */
export function stopAgent(agentId: string) {
  vibrate(10);
  return busyAction(`stop:${agentId}`, "Couldn't stop the agent", () => api.stop(requireBackend(), agentId));
}

function patchAgent(agentId: string, patch: (a: Agent) => Agent) {
  setState((s) => {
    const a = s.agents[agentId];
    return a ? { agents: { ...s.agents, [agentId]: patch(a) } } : {};
  });
}

/** Optimistically set a session option (mode / model / effort …); rolls back on failure. */
export async function setConfigOption(agentId: string, optionId: string, value: string): Promise<boolean> {
  const before = getState().agents[agentId]?.configOptions;
  if (!before) return false;
  patchAgent(agentId, (a) => ({ ...a, configOptions: applyConfigValue(a.configOptions ?? [], optionId, value) }));
  const key = `config:${agentId}:${optionId}`;
  setState((s) => ({ busy: { ...s.busy, [key]: true } }));
  try {
    await api.config(requireBackend(), agentId, optionId, value);
    return true;
  } catch (e) {
    patchAgent(agentId, (a) => ({ ...a, configOptions: before }));
    if (!handleAuthError(e)) toastError("Couldn't change that setting", e);
    return false;
  } finally {
    setState((s) => {
      const busy = { ...s.busy };
      delete busy[key];
      return { busy };
    });
  }
}

export async function switchAccount(agentId: string, accountId: string): Promise<boolean> {
  let ok = false;
  await busyAction(`account:${agentId}`, "Couldn't switch accounts", async () => {
    const agent = await api.switchAccount(requireBackend(), agentId, accountId);
    if (agent && typeof agent.id === "string") setState((s) => ({ agents: { ...s.agents, [agent.id]: agent } }));
    else patchAgent(agentId, (a) => ({ ...a, accountId, rateLimited: false }));
    ok = true;
  });
  return ok;
}

export async function setArchived(agentId: string, archived: boolean, undoable = true) {
  const prev = getState().agents[agentId]?.archived;
  patchAgent(agentId, (a) => ({ ...a, archived }));
  try {
    await api.archive(requireBackend(), agentId, archived);
    pushToast({
      tone: "info",
      title: archived ? "Agent archived" : "Agent restored",
      body: null,
      agentId: null,
      reason: null,
      duration: undoable ? 5_000 : 3_000,
      action: undoable ? { label: "Undo", run: () => void setArchived(agentId, !archived, false) } : undefined,
    });
  } catch (e) {
    if (prev !== undefined) patchAgent(agentId, (a) => ({ ...a, archived: prev }));
    if (!handleAuthError(e)) toastError(archived ? "Couldn't archive the agent" : "Couldn't restore the agent", e);
  }
}

/** Opening an agent marks it read (fire and forget). */
export function markRead(agentId: string) {
  const a = getState().agents[agentId];
  if (!a?.unread || getState().session?.scope !== "owner" || !backend) return;
  patchAgent(agentId, (x) => ({ ...x, unread: false }));
  api.markRead(backend, agentId).catch(() => {
    // Harmless: the desktop keeps it unread and the next agent_updated says so.
  });
}

/** Remove a queued message; returns its text and photos (for "Edit"), or null on failure. */
export async function removeQueued(agentId: string, qid: string): Promise<{ text: string; attachments: Attachment[] } | null> {
  const before = getState().agents[agentId]?.queue;
  patchAgent(agentId, (a) => ({ ...a, queue: (a.queue ?? []).filter((q) => q.id !== qid) }));
  try {
    const res = await api.removeQueued(requireBackend(), agentId, qid);
    if (!res || typeof res.text !== "string") {
      // `text: null`: it left the queue on its own (it's running now).
      pushToast({ tone: "info", title: "That message already started", body: null, agentId: null, reason: null, duration: 4_000 });
      return null;
    }
    const attachments = Array.isArray(res.attachments) ? res.attachments.filter((a) => a && typeof a.data === "string") : [];
    return { text: res.text, attachments };
  } catch (e) {
    if (before) patchAgent(agentId, (a) => ({ ...a, queue: before }));
    if (!handleAuthError(e)) toastError("Couldn't remove that message", e);
    return null;
  }
}

export function resumeQueue(agentId: string) {
  return busyAction(`queue-resume:${agentId}`, "Couldn't resume the queue", async () => {
    await api.resumeQueue(requireBackend(), agentId);
    patchAgent(agentId, (a) => ({ ...a, queuePaused: false }));
  });
}

export function clearQueue(agentId: string) {
  const before = getState().agents[agentId]?.queue;
  patchAgent(agentId, (a) => ({ ...a, queue: [], queuedPrompts: 0 }));
  return busyAction(`queue-clear:${agentId}`, "Couldn't clear the queue", async () => {
    try {
      await api.clearQueue(requireBackend(), agentId);
    } catch (e) {
      if (before) patchAgent(agentId, (a) => ({ ...a, queue: before, queuedPrompts: before.length }));
      throw e;
    }
  });
}

/** Interrupt the current turn and run this queued message now. */
export function sendQueuedNow(agentId: string, qid: string) {
  vibrate(10);
  return busyAction(`queue:${qid}`, "Couldn't send that message", () => api.sendQueuedNow(requireBackend(), agentId, qid));
}

/**
 * Start a new agent; resolves to its id (the UI then opens it). The caller
 * passes the same `key` when retrying the same request, so a timeout never
 * creates a duplicate agent.
 */
export async function createAgent(req: CreateAgentRequest, key: string, onProgress?: (f: number) => void): Promise<string> {
  const agent = await api.createAgent(requireBackend(), req, key, onProgress && throttledProgress(onProgress)).catch((e: unknown) => {
    handleAuthError(e);
    throw e;
  });
  if (!agent || typeof agent.id !== "string") throw new ApiError(502, null, "Armada sent a response this app couldn't read.");
  setState((s) => ({ agents: { ...s.agents, [agent.id]: agent } }));
  return agent.id;
}

/**
 * This device's pairing link, for pairing the iOS Home Screen app (which has
 * its own storage). Only for the stored pairing, never a tab-only share link.
 */
export function currentPairingLink(): string | null {
  if (!current || current.source !== "stored" || devOverrides.backend) return null;
  return `${location.origin}/#token=${encodeURIComponent(current.token)}`;
}

/** A screenshot the agent referenced by local path (owner only; cached). */
export function fetchLocalImage(agentId: string, path: string) {
  return loadLocalImage(agentId, path, () => api.image(requireBackend(), agentId, path));
}

/** What changed in the agent's checkout (owner only). */
export async function loadDiff(agentId: string) {
  try {
    return await api.diff(requireBackend(), agentId);
  } catch (e) {
    handleAuthError(e);
    throw e;
  }
}

/**
 * Commit (or commit & merge) the agent's work. Errors mean nothing changed;
 * a ship that committed but couldn't merge reports a warning.
 */
export async function commitWork(agentId: string, message: string, merge: boolean): Promise<boolean> {
  const key = `commit:${agentId}`;
  if (getState().busy[key]) return false;
  setState((s) => ({ busy: { ...s.busy, [key]: true } }));
  try {
    if (merge) {
      const r = await api.ship(requireBackend(), agentId, message);
      const outcome = shipOutcome(r);
      pushToast({ ...outcome, agentId: null, reason: null, duration: outcome.tone === "warn" ? 10_000 : 6_000 });
    } else {
      const r = await api.commit(requireBackend(), agentId, message);
      pushToast({ tone: "ok", title: "Committed", body: commitMessage(r?.result), agentId: null, reason: null, duration: 6_000 });
    }
    return true;
  } catch (e) {
    if (!handleAuthError(e)) toastError(merge ? "Couldn't commit and merge" : "Couldn't commit", e);
    return false;
  } finally {
    setState((s) => {
      const busy = { ...s.busy };
      delete busy[key];
      return { busy };
    });
  }
}

/** "Retry now" on the reconnecting banner. */
export function reconnectNow() {
  connection?.nudge("online");
}
