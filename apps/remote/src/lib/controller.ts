/**
 * App controller: owns the backend, the live-event connection and every
 * server round-trip. Components read state through `useStore` and call the
 * exported actions; nothing else talks to the network.
 *
 * Consistency model
 * - The event stream is the source of truth for changes. Every time it
 *   (re)opens we refetch `/api/state` and the timelines we care about, so
 *   anything missed while disconnected is recovered.
 * - While a snapshot request is in flight, events for the same data are
 *   recorded and re-applied on top of the snapshot so nothing is lost.
 */
import { ApiError, api, errorMessage, HttpBackend, type Backend } from "./api";
import { clearToken, storeToken, takeInitialToken } from "./auth";
import { getRoute, navigate } from "./router";
import {
  applyDelta,
  getState,
  initialState,
  setState,
  sortItems,
  upsertItem,
  type PendingPrompt,
  type Timeline,
  type Toast,
} from "./store";
import type { Agent, AttentionEvent, RemoteEvent, StateSnapshot, TimelineItem } from "./types";

let backend: Backend | null = null;
let connection: ConnectionHandle | null = null;
let generation = 0; // bumped on unpair/re-pair so late responses are discarded

// ---------------------------------------------------------------------------
// Boot / pairing

export interface DevOverrides {
  backend?: Backend;
  /** Start on the pairing screen (mock deep link). */
  forceUnpaired?: "plain" | "revoked";
}

let devOverrides: DevOverrides = {};

export async function boot() {
  const initial = takeInitialToken();

  if (import.meta.env.DEV) {
    const { resolveDevBackend } = await import("../mock/dev");
    const dev = await resolveDevBackend();
    if (dev) {
      devOverrides = dev;
      if (dev.forceUnpaired) {
        setState({ phase: "unpaired", unpairedReason: dev.forceUnpaired === "revoked" ? "revoked" : null });
        return;
      }
      await connect("dev-mock-token", false);
      return;
    }
  }

  if (!initial.token) {
    setState({ phase: "unpaired", unpairedReason: initial.invalidLink ? "invalid_link" : null });
    return;
  }
  await connect(initial.token, initial.fresh);
}

/** Pair using a token entered on the pairing screen. */
export async function pairWithToken(token: string) {
  storeToken(token);
  await connect(token, true);
}

/** Retry from the "can't reach Armada" / rate-limited screens (stays on that screen until it works). */
export async function retryConnect() {
  const token = currentToken;
  if (token) await connect(token, false, true);
  else setState({ phase: "unpaired" });
}

let currentToken: string | null = null;

async function connect(token: string, fresh: boolean, quiet = false) {
  const gen = ++generation;
  currentToken = token;
  connection?.stop();
  connection = null;
  backend = devOverrides.backend ?? new HttpBackend(token);
  if (!quiet) setState({ phase: "boot", blockedReason: null, blockedMessage: null });

  try {
    const session = await api.session(backend);
    if (gen !== generation) return;
    if (!session || (session.scope !== "owner" && session.scope !== "viewer")) {
      throw new ApiError(502, null, "Armada sent a response this app couldn't read.");
    }
    setState({
      session,
      phase: "ready",
      unpairedReason: null,
      stateStatus: getState().stateStatus === "ready" ? "ready" : "loading",
    });
    if (session.scope === "viewer" && session.agentId) {
      navigate({ name: "agent", agentId: session.agentId }, { replace: true });
    }
    connection = openConnection(backend, gen);
  } catch (e) {
    if (gen !== generation) return;
    if (e instanceof ApiError && e.isUnauthorized) {
      clearToken();
      resetData();
      setState({ phase: "unpaired", unpairedReason: fresh ? "invalid_link" : "revoked" });
    } else if (e instanceof ApiError && e.isRateLimited) {
      setState({ phase: "blocked", blockedReason: "rate_limited", blockedMessage: e.message });
    } else {
      const unreachable = e instanceof ApiError && (e.isNetwork || e.status === 408);
      setState({
        phase: "blocked",
        blockedReason: unreachable ? "unreachable" : "error",
        blockedMessage: errorMessage(e),
      });
    }
  }
}

/** Forget this device's token (the server isn't told; revoke it on the desktop). */
export function unpair() {
  generation++;
  connection?.stop();
  connection = null;
  backend = null;
  currentToken = null;
  clearToken();
  resetData();
  setState({ phase: "unpaired", unpairedReason: null });
  navigate({ name: "fleet" }, { replace: true });
}

function onUnauthorized() {
  generation++;
  connection?.stop();
  connection = null;
  backend = null;
  currentToken = null;
  clearToken();
  resetData();
  setState({ phase: "unpaired", unpairedReason: "revoked" });
  navigate({ name: "fleet" }, { replace: true });
}

function resetData() {
  const { toasts } = getState();
  setState({ ...initialState, toasts: toasts.filter((t) => !t.agentId) });
  itemsInFlight.clear();
  itemBuffers.clear();
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

function setConnection(next: "connecting" | "live" | "reconnecting" | "offline") {
  const s = getState();
  if (s.connection === next) return;
  setState({
    connection: next,
    disconnectedAt: next === "live" ? null : (s.disconnectedAt ?? Date.now()),
  });
}

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
            if (alive()) handleEvent(data);
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
          if (e.isRateLimited) attempt = Math.max(attempt, 5);
        }
      } finally {
        controller = null;
      }
      if (!alive()) return;
      setConnection(navigator.onLine ? "reconnecting" : "offline");
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
        // Connection looks healthy; the tab may still have missed events while frozen.
        if (reason === "visible") void resync();
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
const itemBuffers = new Map<string, TimelineItem[]>();
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
    // Everything cached is potentially out of date now.
    setState((s) => {
      const timelines: Record<string, Timeline> = {};
      for (const [id, t] of Object.entries(s.timelines)) timelines[id] = t.status === "ready" ? { ...t, stale: true } : t;
      return { timelines };
    });
    await refreshState();
    const route = getRoute();
    if (route.name === "agent") void loadTimeline(route.agentId);
    loadInboxTimelines();
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
    setState((s) => {
      const timelines = { ...s.timelines };
      for (const id of Object.keys(timelines)) if (!agents[id]) delete timelines[id];
      return { agents, accounts, customAgents, timelines, stateStatus: "ready", stateError: null };
    });
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
    const raw = await api.items(b, agentId);
    if (gen !== generation) return;
    if (!Array.isArray(raw)) throw new ApiError(502, null, "Armada sent a response this app couldn't read.");
    let items = sortItems(raw.filter((i) => i && typeof i.id === "string" && typeof i.kind === "string"));
    for (const it of itemBuffers.get(agentId) ?? []) items = upsertItem(items, it);
    setTimeline(agentId, { status: "ready", items, error: null, stale: false });
    reconcile(agentId, items);
    touchLru(agentId);
  } catch (e) {
    if (gen !== generation) return;
    if (handleAuthError(e)) return;
    const cur = getState().timelines[agentId];
    if (cur && cur.status === "ready") {
      // Keep showing what we have; it's marked stale and retried on the next resync.
      setTimeline(agentId, { ...cur, stale: true });
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

/** The inbox needs the timeline of every agent that is waiting on an approval. */
export function loadInboxTimelines() {
  const s = getState();
  if (s.session?.scope !== "owner") return;
  for (const a of Object.values(s.agents)) {
    if (a.pendingPermissions > 0 && !a.archived) ensureTimeline(a.id);
  }
}

// ---------------------------------------------------------------------------
// Events

function handleEvent(raw: string) {
  let ev: RemoteEvent;
  try {
    ev = JSON.parse(raw) as RemoteEvent;
  } catch {
    return;
  }
  if (!ev || typeof ev !== "object" || typeof ev.type !== "string") return;

  switch (ev.type) {
    case "agent_updated": {
      const agent = ev.agent;
      if (!agent || typeof agent.id !== "string") return;
      stateJournal?.updated.set(agent.id, agent);
      stateJournal?.removed.delete(agent.id);
      const prev = getState().agents[agent.id];
      setState((s) => ({ agents: { ...s.agents, [agent.id]: agent } }));
      if (agent.pendingPermissions > 0 && (prev?.pendingPermissions ?? 0) < agent.pendingPermissions) {
        if (getState().session?.scope === "owner") ensureTimeline(agent.id);
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
        return { agents, timelines, pendingPrompts };
      });
      return;
    }
    case "item_upserted": {
      const item = ev.item;
      if (!item || typeof item.id !== "string") return;
      itemBuffers.get(item.agentId)?.push(item);
      const t = getState().timelines[item.agentId];
      if (t && t.status !== "error") {
        const items = upsertItem(t.items, item);
        setTimeline(item.agentId, { ...t, items });
        reconcile(item.agentId, [item]);
      } else if (item.kind === "permission" && item.resolution === null && getState().session?.scope === "owner") {
        ensureTimeline(item.agentId);
      }
      return;
    }
    case "text_delta": {
      // Deltas can't be replayed safely onto a snapshot (no offsets), so while a
      // fetch is in flight they're dropped; the snapshot or the next upsert has the text.
      if (itemsInFlight.has(ev.agentId)) return;
      const t = getState().timelines[ev.agentId];
      if (!t || t.status !== "ready") return;
      const items = applyDelta(t.items, ev.itemId, ev.field, ev.delta);
      if (items !== t.items) setTimeline(ev.agentId, { ...t, items });
      return;
    }
    case "attention":
      onAttention(ev);
      return;
    case "resync":
      void resync();
      return;
    default:
      // Unknown event types from a newer server are ignored on purpose.
      return;
  }
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
  let pending = s.pendingPrompts[agentId];
  if (pending?.length) {
    const echoed = items.filter((i) => i.kind === "user_message");
    if (echoed.length) {
      const remaining = pending.slice();
      for (const m of echoed) {
        const idx = remaining.findIndex((p) => !p.failed && p.afterSeq < m.seq && p.text.trim() === m.text.trim());
        if (idx >= 0) remaining.splice(idx, 1);
      }
      if (remaining.length !== pending.length) pending = remaining;
    }
  }
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
    setState((st) => {
      const resolving = { ...st.resolving };
      delete resolving[requestId];
      const agent = st.agents[agentId];
      const agents =
        agent && agent.pendingPermissions > 0
          ? { ...st.agents, [agentId]: { ...agent, pendingPermissions: agent.pendingPermissions - 1 } }
          : st.agents;
      return { resolving, agents };
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
      void loadTimeline(agentId);
      void refreshState();
    } else {
      toastError("Couldn't send your answer", e);
    }
    return false;
  }
}

let promptSeq = 0;

export async function sendPrompt(agentId: string, text: string, retryOf?: string) {
  const body = text.trim();
  if (!body) return;
  const t = getState().timelines[agentId];
  const afterSeq = t?.items.length ? t.items[t.items.length - 1].seq : -1;
  const id = retryOf ?? `p${++promptSeq}`;
  const entry: PendingPrompt = { id, text: body, ts: Date.now(), failed: false, afterSeq };
  setState((s) => {
    const list = (s.pendingPrompts[agentId] ?? []).filter((p) => p.id !== id);
    return { pendingPrompts: { ...s.pendingPrompts, [agentId]: [...list, entry] } };
  });
  try {
    await api.prompt(requireBackend(), agentId, body);
  } catch (e) {
    setState((s) => ({
      pendingPrompts: {
        ...s.pendingPrompts,
        [agentId]: (s.pendingPrompts[agentId] ?? []).map((p) => (p.id === id ? { ...p, failed: true } : p)),
      },
    }));
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

/** "Retry now" on the reconnecting banner. */
export function reconnectNow() {
  connection?.nudge("online");
}
