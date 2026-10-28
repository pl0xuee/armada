import { useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { api } from "@/lib/api";
import type {
  Account,
  Agent,
  AppState,
  ArmadaEvent,
  ProviderInfo,
  Settings,
  TimelineItem,
  UpdateInfo,
} from "@/lib/types";
import { errorMessage } from "@/lib/utils";
import { forgetAgentDerived } from "@/components/agent/derived";
import { useUi } from "./ui";

export interface AppStore {
  booted: boolean;
  bootError: string | null;
  version: string;
  platform: AppState["platform"];

  agents: Record<string, Agent>;
  accounts: Account[];
  providers: ProviderInfo[];
  settings: Settings | null;

  /** Available app update (from update_available or a manual check). */
  update: UpdateInfo | null;
  updateDismissed: boolean;
  /** Set while an update is downloading/installing. */
  updateProgress: { downloaded: number; total: number | null } | null;

  /** Timeline items per agent, sorted by seq. Absent = not loaded yet. */
  items: Record<string, TimelineItem[]>;
  itemsLoading: Record<string, boolean>;
  /** Last timeline load error per agent (cleared on retry). */
  itemsError: Record<string, string>;
  /** True when older items exist before the loaded tail (paged in by loadOlder). */
  hasOlder: Record<string, boolean>;
  olderLoading: Record<string, boolean>;
  /** Set when the event stream from the core couldn't be established/was lost. */
  connectionLost: string | null;

  boot: () => Promise<void>;
  applyEvent: (e: ArmadaEvent) => void;
  applyEvents: (events: ArmadaEvent[]) => void;
  ensureItems: (agentId: string, force?: boolean) => Promise<void>;
  /** Page in the previous PAGE_SIZE items before the loaded ones. */
  loadOlder: (agentId: string) => Promise<void>;
  setSettings: (s: Settings) => Promise<void>;
  patchSettings: (patch: Partial<Settings>) => Promise<void>;
  upsertAgent: (a: Agent) => void;
  upsertAccount: (a: Account) => void;
  removeAccount: (id: string) => void;
  setProviders: (p: ProviderInfo[]) => void;
  setUpdate: (u: UpdateInfo | null) => void;
}

/** Insert or replace an item, keeping seq order. Searches from the end (new items land there). */
export function insertBySeq(list: TimelineItem[], item: TimelineItem): TimelineItem[] {
  const idx = list.findLastIndex((i) => i.id === item.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = item;
    return next;
  }
  const last = list[list.length - 1];
  if (!last || last.seq <= item.seq) return [...list, item];
  const next = [...list, item];
  next.sort((a, b) => a.seq - b.seq);
  return next;
}

export type TextDelta = Extract<ArmadaEvent, { type: "text_delta" }>;
export type ItemEvent = Extract<ArmadaEvent, { type: "item_upserted" | "text_delta" }>;

function fieldOf(item: TimelineItem, field: "text" | "output"): string | null {
  if (field === "output") return item.kind === "tool_call" ? item.output : null;
  return item.kind === "agent_message" ||
    item.kind === "thought" ||
    item.kind === "user_message" ||
    item.kind === "notice"
    ? item.text
    : null;
}

/**
 * Offset-based streaming append (offset = field length before the delta):
 * equal → append · smaller → skip duplicates, otherwise overwrite from offset · larger → gap.
 */
export function applyDelta(item: TimelineItem, e: TextDelta): { item: TimelineItem; gap: boolean } {
  const cur = fieldOf(item, e.field);
  if (cur === null) return { item, gap: false };
  let next: string;
  if (e.offset === cur.length) next = cur + e.delta;
  else if (e.offset < cur.length) {
    if (cur.startsWith(e.delta, e.offset)) return { item, gap: false };
    next = cur.slice(0, e.offset) + e.delta;
  } else return { item, gap: true };
  return {
    item:
      e.field === "output" ? ({ ...item, output: next } as TimelineItem) : ({ ...item, text: next } as TimelineItem),
    gap: false,
  };
}

/** Apply one item event to a loaded timeline. Unknown item ids for deltas count as a gap. */
export function reduceItems(list: TimelineItem[], e: ItemEvent): { list: TimelineItem[]; gap: boolean } {
  if (e.type === "item_upserted") return { list: insertBySeq(list, e.item), gap: false };
  // Streaming targets the newest items: search from the end.
  const idx = list.findLastIndex((i) => i.id === e.itemId);
  if (idx < 0) return { list, gap: true };
  const r = applyDelta(list[idx], e);
  if (r.item === list[idx]) return { list, gap: r.gap };
  const next = list.slice();
  next[idx] = r.item;
  return { list: next, gap: r.gap };
}

/** Timeline page size: the tail loads first, older pages on scroll. */
export const PAGE_SIZE = 300;

/**
 * Apply one item event to a per-batch mutable copy of a timeline (searching from the end,
 * where streaming happens). Returns true when a delta revealed a gap.
 */
export function applyInPlace(list: TimelineItem[], e: ItemEvent): boolean {
  if (e.type === "item_upserted") {
    const idx = list.findLastIndex((i) => i.id === e.item.id);
    if (idx >= 0) list[idx] = e.item;
    else {
      const last = list[list.length - 1];
      list.push(e.item);
      if (last && last.seq > e.item.seq) list.sort((a, b) => a.seq - b.seq);
    }
    return false;
  }
  const idx = list.findLastIndex((i) => i.id === e.itemId);
  if (idx < 0) return true;
  const r = applyDelta(list[idx], e);
  list[idx] = r.item;
  return r.gap;
}

/** Field-level equality, ignoring updatedAt (small objects: JSON for nested fields). */
export function sameAgent(a: Agent, b: Agent): boolean {
  for (const k of Object.keys(b) as (keyof Agent)[]) {
    if (k === "updatedAt") continue;
    const x = a[k];
    const y = b[k];
    if (x === y) continue;
    if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) return false;
    if (JSON.stringify(x) !== JSON.stringify(y)) return false;
  }
  return Object.keys(a).length === Object.keys(b).length;
}

/** Agents hidden while an undoable delete is pending (events for them are ignored). */
const suppressed = new Set<string>();

export function suppressAgent(id: string, on: boolean) {
  if (on) suppressed.add(id);
  else suppressed.delete(id);
}

/**
 * Agents deleted for real. A late snapshot (boot, an invoke result, a stale event) must not
 * bring them back.
 */
const removed = new Set<string>();

export function markRemoved(id: string) {
  removed.add(id);
  for (const fn of removedListeners) fn(id);
}

const removedListeners = new Set<(id: string) => void>();

/** Called when an agent is deleted for real (not on a pending, undoable delete). */
export function onAgentRemoved(fn: (id: string) => void): () => void {
  removedListeners.add(fn);
  return () => removedListeners.delete(fn);
}

/** True while an undoable delete is pending for the agent. */
export function isSuppressed(id: string): boolean {
  return suppressed.has(id);
}

/** Events that arrive while a timeline is (re)loading, replayed over the snapshot. */
const buffered = new Map<string, ItemEvent[]>();
const pendingRefetch = new Set<string>();
const refetchTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Most-recently-opened agents first; timelines beyond MAX_CACHED are evicted. */
const recent: string[] = [];
const MAX_CACHED = 10;

function touch(agentId: string) {
  const i = recent.indexOf(agentId);
  if (i >= 0) recent.splice(i, 1);
  recent.unshift(agentId);
}

const LIVE = new Set(["working", "starting", "needs_permission"]);

/**
 * Drop cached timelines of agents not opened recently. Never evicts the selected agent, live
 * agents (Mission Control shows their activity) or agents with pending approvals (Inbox).
 */
function evictTimelines(items: Record<string, TimelineItem[]>, agents: Record<string, Agent>, selected: string | null) {
  const keep = new Set(recent.slice(0, MAX_CACHED));
  let out: Record<string, TimelineItem[]> | null = null;
  for (const id of Object.keys(items)) {
    const a = agents[id];
    if (keep.has(id) || id === selected || (a && (LIVE.has(a.status) || a.pendingPermissions > 0))) continue;
    out ??= { ...items };
    delete out[id];
    forgetAgentDerived(id);
    const i = recent.indexOf(id);
    if (i >= 0) recent.splice(i, 1);
  }
  return out;
}
let settingsVersion = 0;

function itemEventAgent(e: ItemEvent): string {
  return e.type === "item_upserted" ? e.item.agentId : e.agentId;
}

export const useApp = create<AppStore>((set, get) => ({
  booted: false,
  bootError: null,
  version: "",
  platform: "linux",
  agents: {},
  accounts: [],
  providers: [],
  settings: null,
  update: null,
  updateDismissed: false,
  updateProgress: null,
  items: {},
  itemsLoading: {},
  itemsError: {},
  hasOlder: {},
  olderLoading: {},
  connectionLost: null,

  boot: async () => {
    try {
      const s = await api.getState();
      // Events may have arrived while getState was in flight: keep whichever copy is newer.
      const live = get().agents;
      const agents: Record<string, Agent> = {};
      for (const a of s.agents) {
        if (removed.has(a.id)) continue;
        const cur = live[a.id];
        agents[a.id] = cur && cur.updatedAt > a.updatedAt ? cur : a;
      }
      // Agents created while getState was in flight aren't in the snapshot: keep them.
      for (const [id, a] of Object.entries(live)) if (!(id in agents) && !removed.has(id)) agents[id] = a;
      set({
        booted: true,
        bootError: null,
        version: s.version,
        platform: s.platform,
        agents,
        // The implicit "system-custom" account backs custom ACP agents; it has no sign-in, so it isn't listed.
        accounts: s.accounts.filter((a) => a.provider !== "custom"),
        providers: s.providers,
        settings: s.settings,
      });
      // Agents with pending approvals are always loaded so the Inbox can list them.
      for (const a of s.agents) {
        if (a.pendingPermissions > 0) void get().ensureItems(a.id);
      }
    } catch (e) {
      set({ bootError: errorMessage(e) });
    }
  },

  ensureItems: async (agentId, force = false) => {
    touch(agentId);
    const { items, itemsLoading } = get();
    if (itemsLoading[agentId]) {
      // A refetch asked for mid-load would be dropped: run it once this load finishes.
      if (force) pendingRefetch.add(agentId);
      return;
    }
    if (!force && items[agentId]) return;
    buffered.set(agentId, []);
    const errors = { ...get().itemsError };
    delete errors[agentId];
    set({ itemsLoading: { ...get().itemsLoading, [agentId]: true }, itemsError: errors });
    try {
      // Tail-first: the newest PAGE_SIZE items; older ones page in on scroll (loadOlder).
      const snapshot = await api.listItems(agentId, { limit: PAGE_SIZE });
      // The agent may have been deleted meanwhile.
      if (!get().agents[agentId] || removed.has(agentId)) return;
      const tail = snapshot.slice().sort((a, b) => a.seq - b.seq);
      // A refetch only reloads the tail: keep already-loaded older items before it.
      const prev = get().items[agentId];
      const firstTailSeq = tail[0]?.seq ?? Infinity;
      const older = prev ? prev.filter((i) => i.seq < firstTailSeq) : [];
      let list = older.length ? [...older, ...tail] : tail;
      let gap = false;
      for (const ev of buffered.get(agentId) ?? []) {
        const r = reduceItems(list, ev);
        list = r.list;
        // Deltas that predate the snapshot are duplicates; only a forward gap matters.
        gap ||= r.gap && ev.type === "text_delta" && list.some((i) => i.id === ev.itemId);
      }
      const next = { ...get().items, [agentId]: list };
      set({
        items: evictTimelines(next, get().agents, useUi.getState().selectedAgentId) ?? next,
        // First load: a full page means there's more before it. A tail refetch keeps what we knew.
        hasOlder: {
          ...get().hasOlder,
          [agentId]: prev ? (get().hasOlder[agentId] ?? false) : snapshot.length >= PAGE_SIZE,
        },
      });
      if (gap) scheduleRefetch(agentId);
    } catch (e) {
      if (get().agents[agentId] && !removed.has(agentId)) {
        set({ itemsError: { ...get().itemsError, [agentId]: errorMessage(e) } });
      }
    } finally {
      buffered.delete(agentId);
      const loading = { ...get().itemsLoading };
      delete loading[agentId];
      set({ itemsLoading: loading });
      if (pendingRefetch.delete(agentId) && get().agents[agentId] && !removed.has(agentId)) {
        void get().ensureItems(agentId, true);
      }
    }
  },

  loadOlder: async (agentId) => {
    const { items, hasOlder, olderLoading } = get();
    const list = items[agentId];
    if (!list || !hasOlder[agentId] || olderLoading[agentId]) return;
    const first = list[0]?.seq;
    if (first === undefined) return;
    set({ olderLoading: { ...olderLoading, [agentId]: true } });
    try {
      const page = await api.listItems(agentId, { beforeSeq: first, limit: PAGE_SIZE });
      const cur = get().items[agentId];
      if (!cur || removed.has(agentId)) return;
      const have = new Set(cur.map((i) => i.id));
      const older = page.filter((i) => !have.has(i.id)).sort((a, b) => a.seq - b.seq);
      set({
        items: { ...get().items, [agentId]: [...older, ...cur] },
        hasOlder: { ...get().hasOlder, [agentId]: page.length >= PAGE_SIZE },
      });
    } catch (e) {
      set({ itemsError: { ...get().itemsError, [agentId]: errorMessage(e) } });
    } finally {
      const loading = { ...get().olderLoading };
      delete loading[agentId];
      set({ olderLoading: loading });
    }
  },

  setSettings: async (s) => {
    const prev = get().settings;
    const version = ++settingsVersion;
    set({ settings: s });
    try {
      const saved = await api.updateSettings(s);
      // A newer save is in flight: let it win.
      if (version === settingsVersion) set({ settings: saved });
    } catch (e) {
      if (version === settingsVersion) set({ settings: prev });
      throw e;
    }
  },

  patchSettings: async (patch) => {
    const cur = get().settings;
    if (!cur) return;
    await get().setSettings({ ...cur, ...patch });
  },

  // An invoke result can be older than an event that already arrived: keep the newer copy.
  upsertAgent: (a) => {
    if (removed.has(a.id)) return;
    const cur = get().agents[a.id];
    if (cur && cur.updatedAt > a.updatedAt) return;
    set({ agents: { ...get().agents, [a.id]: a } });
  },

  upsertAccount: (a) => {
    if (a.provider === "custom") return;
    const list = get().accounts;
    const idx = list.findIndex((x) => x.id === a.id);
    set({ accounts: idx >= 0 ? list.map((x) => (x.id === a.id ? a : x)) : [...list, a] });
  },

  removeAccount: (id) => set({ accounts: get().accounts.filter((a) => a.id !== id) }),
  setProviders: (providers) => set({ providers }),
  setUpdate: (update) => set({ update, updateDismissed: false }),

  applyEvent: (e) => get().applyEvents([e]),

  /**
   * Apply a batch of events (one animation frame's worth) in a single store update, so a
   * burst of streaming deltas costs one render instead of one per event.
   */
  applyEvents: (events) => {
    const st = get();
    let agents = st.agents;
    let items = st.items;
    let accounts = st.accounts;
    let changedAgents = false;
    let changedItems = false;
    const patch: Partial<AppStore> = {};
    const toLoad = new Set<string>();
    const refetch = new Set<string>();
    // One mutable copy per touched timeline per batch (not one slice per delta).
    const working = new Map<string, TimelineItem[]>();

    for (const e of events) {
      const target =
        e.type === "agent_updated"
          ? e.agent.id
          : e.type === "item_upserted"
            ? e.item.agentId
            : e.type === "text_delta"
              ? e.agentId
              : null;
      if (target && (suppressed.has(target) || removed.has(target))) continue;
      switch (e.type) {
        case "agent_updated": {
          const prev = agents[e.agent.id];
          // Out-of-order (older) copy, or nothing but updatedAt changed: keep the current object,
          // so usage ticks don't re-render everything that reads this agent.
          if (prev && (prev.updatedAt > e.agent.updatedAt || sameAgent(prev, e.agent))) break;
          if (!changedAgents) agents = { ...agents };
          changedAgents = true;
          agents[e.agent.id] = e.agent;
          if (e.agent.pendingPermissions > 0 && (!prev || prev.pendingPermissions === 0)) toLoad.add(e.agent.id);
          break;
        }
        case "agent_removed": {
          removed.add(e.agentId);
          for (const fn of removedListeners) fn(e.agentId);
          buffered.delete(e.agentId);
          pendingRefetch.delete(e.agentId);
          const ri = recent.indexOf(e.agentId);
          if (ri >= 0) recent.splice(ri, 1);
          if (st.itemsLoading[e.agentId] !== undefined) {
            patch.itemsLoading = { ...(patch.itemsLoading ?? st.itemsLoading) };
            delete patch.itemsLoading[e.agentId];
          }
          if (st.hasOlder[e.agentId] !== undefined) {
            patch.hasOlder = { ...(patch.hasOlder ?? st.hasOlder) };
            delete patch.hasOlder[e.agentId];
          }
          if (st.itemsError[e.agentId] !== undefined) {
            patch.itemsError = { ...(patch.itemsError ?? st.itemsError) };
            delete patch.itemsError[e.agentId];
          }
          const t = refetchTimers.get(e.agentId);
          if (t) clearTimeout(t);
          refetchTimers.delete(e.agentId);
          if (!changedAgents) agents = { ...agents };
          changedAgents = true;
          delete agents[e.agentId];
          forgetAgentDerived(e.agentId);
          if (items[e.agentId]) {
            if (!changedItems) items = { ...items };
            changedItems = true;
            delete items[e.agentId];
          }
          break;
        }
        case "item_upserted":
        case "text_delta": {
          const agentId = itemEventAgent(e);
          const loading = st.itemsLoading[agentId];
          if (loading) buffered.get(agentId)?.push(e);
          if (!items[agentId] && !working.has(agentId)) {
            // Not loaded: permissions must reach the Inbox, everything else loads lazily.
            if (!loading && e.type === "item_upserted" && e.item.kind === "permission") toLoad.add(agentId);
            break;
          }
          let list = working.get(agentId);
          if (!list) {
            list = items[agentId].slice();
            working.set(agentId, list);
          }
          if (applyInPlace(list, e) && !loading) refetch.add(agentId);
          break;
        }
        case "account_updated": {
          if (e.account.provider === "custom") break;
          const idx = accounts.findIndex((x) => x.id === e.account.id);
          accounts = idx >= 0 ? accounts.map((x) => (x.id === e.account.id ? e.account : x)) : [...accounts, e.account];
          break;
        }
        case "account_removed":
          accounts = accounts.filter((a) => a.id !== e.accountId);
          break;
        case "providers_changed":
          patch.providers = e.providers;
          break;
        case "update_available":
          // Don't re-show a dismissed banner for the same version.
          if ((patch.update ?? st.update)?.version !== e.update.version || !st.updateDismissed) {
            patch.update = e.update;
            patch.updateDismissed = false;
          }
          break;
        case "update_progress":
          patch.updateProgress = { downloaded: e.downloaded, total: e.total };
          break;
        // attention / terminal / navigate are UI concerns, handled in store/events.ts
        default:
          break;
      }
    }

    if (working.size) {
      if (!changedItems) items = { ...items };
      changedItems = true;
      for (const [id, list] of working) if (!removed.has(id)) items[id] = list;
    }
    if (changedAgents) patch.agents = agents;
    if (changedItems) patch.items = items;
    if (accounts !== st.accounts) patch.accounts = accounts;
    if (Object.keys(patch).length) set(patch);
    for (const id of toLoad) void get().ensureItems(id);
    for (const id of refetch) scheduleRefetch(id);
  },
}));

/**
 * A delta gap means we missed text: refetch the timeline. Throttled, not debounced: a pending
 * refetch isn't pushed back by later gaps, so a long stream can't starve it. (The stream's final
 * upsert also heals the item.)
 */
function scheduleRefetch(agentId: string) {
  if (refetchTimers.has(agentId)) return;
  refetchTimers.set(
    agentId,
    setTimeout(() => {
      refetchTimers.delete(agentId);
      if (useApp.getState().agents[agentId]) void useApp.getState().ensureItems(agentId, true);
    }, 600),
  );
}

// ---------------------------------------------------------------- selectors

export const selectAgentList = (s: AppStore) => Object.values(s.agents);

export function accountById(accounts: Account[], id: string): Account | undefined {
  return accounts.find((a) => a.id === id);
}

export interface PendingPermission {
  agent: Agent;
  item: Extract<TimelineItem, { kind: "permission" }>;
}

/** All unresolved permission requests across loaded agents, oldest first. */
export function collectPending(s: Pick<AppStore, "agents" | "items">): PendingPermission[] {
  const out: PendingPermission[] = [];
  for (const agent of Object.values(s.agents)) {
    if (agent.pendingPermissions <= 0) continue;
    const list = s.items[agent.id];
    if (!list) continue;
    for (const item of list) {
      if (item.kind === "permission" && item.resolution === null) out.push({ agent, item });
    }
  }
  return out.sort((a, b) => a.item.ts - b.item.ts);
}

export function pendingCount(agents: Record<string, Agent>): number {
  let n = 0;
  for (const a of Object.values(agents)) n += a.pendingPermissions;
  return n;
}

/**
 * Pending permissions, re-rendering only when an agent or permission item actually changes
 * (not on every streamed delta of unrelated items).
 */
export function usePendingPermissions(): PendingPermission[] {
  const flat = useApp(useShallow((s) => collectPending(s).flatMap((p) => [p.agent, p.item])));
  return useMemo(() => {
    const out: PendingPermission[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      out.push({ agent: flat[i] as Agent, item: flat[i + 1] as PendingPermission["item"] });
    }
    return out;
  }, [flat]);
}
