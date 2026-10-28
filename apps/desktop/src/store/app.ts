import { create } from "zustand";
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

  boot: () => Promise<void>;
  applyEvent: (e: ArmadaEvent) => void;
  ensureItems: (agentId: string, force?: boolean) => Promise<void>;
  setSettings: (s: Settings) => Promise<void>;
  patchSettings: (patch: Partial<Settings>) => Promise<void>;
  upsertAgent: (a: Agent) => void;
  upsertAccount: (a: Account) => void;
  removeAccount: (id: string) => void;
  setProviders: (p: ProviderInfo[]) => void;
  setUpdate: (u: UpdateInfo | null) => void;
}

function insertBySeq(list: TimelineItem[], item: TimelineItem): TimelineItem[] {
  const idx = list.findIndex((i) => i.id === item.id);
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

function applyDelta(item: TimelineItem, field: "text" | "output", delta: string): TimelineItem {
  if (field === "output" && item.kind === "tool_call") return { ...item, output: item.output + delta };
  if (
    field === "text" &&
    (item.kind === "agent_message" || item.kind === "thought" || item.kind === "user_message" || item.kind === "notice")
  ) {
    return { ...item, text: item.text + delta };
  }
  return item;
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

  boot: async () => {
    try {
      const s = await api.getState();
      const agents: Record<string, Agent> = {};
      for (const a of s.agents) agents[a.id] = a;
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
    const { items, itemsLoading } = get();
    if (!force && (items[agentId] || itemsLoading[agentId])) return;
    set({ itemsLoading: { ...get().itemsLoading, [agentId]: true } });
    try {
      const list = await api.listItems(agentId);
      list.sort((a, b) => a.seq - b.seq);
      // Merge with anything that streamed in while we were loading.
      const live = get().items[agentId] ?? [];
      let merged = list;
      for (const it of live) merged = insertBySeq(merged, it);
      set({ items: { ...get().items, [agentId]: merged } });
    } finally {
      set({ itemsLoading: { ...get().itemsLoading, [agentId]: false } });
    }
  },

  setSettings: async (s) => {
    const prev = get().settings;
    set({ settings: s });
    try {
      const saved = await api.updateSettings(s);
      set({ settings: saved });
    } catch (e) {
      set({ settings: prev });
      throw e;
    }
  },

  patchSettings: async (patch) => {
    const cur = get().settings;
    if (!cur) return;
    await get().setSettings({ ...cur, ...patch });
  },

  upsertAgent: (a) => set({ agents: { ...get().agents, [a.id]: a } }),

  upsertAccount: (a) => {
    if (a.provider === "custom") return;
    const list = get().accounts;
    const idx = list.findIndex((x) => x.id === a.id);
    set({ accounts: idx >= 0 ? list.map((x) => (x.id === a.id ? a : x)) : [...list, a] });
  },

  removeAccount: (id) => set({ accounts: get().accounts.filter((a) => a.id !== id) }),
  setProviders: (providers) => set({ providers }),
  setUpdate: (update) => set({ update, updateDismissed: false }),

  applyEvent: (e) => {
    switch (e.type) {
      case "agent_updated": {
        const prev = get().agents[e.agent.id];
        get().upsertAgent(e.agent);
        if (e.agent.pendingPermissions > 0 && (!prev || prev.pendingPermissions === 0)) {
          void get().ensureItems(e.agent.id);
        }
        break;
      }
      case "agent_removed": {
        const agents = { ...get().agents };
        delete agents[e.agentId];
        const items = { ...get().items };
        delete items[e.agentId];
        set({ agents, items });
        break;
      }
      case "item_upserted": {
        const { items } = get();
        const list = items[e.item.agentId];
        // Only track agents whose timeline is loaded; the rest load lazily.
        if (!list) {
          if (e.item.kind === "permission") void get().ensureItems(e.item.agentId);
          return;
        }
        set({ items: { ...items, [e.item.agentId]: insertBySeq(list, e.item) } });
        break;
      }
      case "text_delta": {
        const { items } = get();
        const list = items[e.agentId];
        if (!list) return;
        const idx = list.findIndex((i) => i.id === e.itemId);
        if (idx < 0) return;
        const next = list.slice();
        next[idx] = applyDelta(list[idx], e.field, e.delta);
        set({ items: { ...items, [e.agentId]: next } });
        break;
      }
      case "account_updated":
        get().upsertAccount(e.account);
        break;
      case "account_removed":
        get().removeAccount(e.accountId);
        break;
      case "providers_changed":
        set({ providers: e.providers });
        break;
      case "update_available":
        // Don't re-show a dismissed banner for the same version.
        if (get().update?.version !== e.update.version || !get().updateDismissed) {
          set({ update: e.update, updateDismissed: false });
        }
        break;
      case "update_progress":
        set({ updateProgress: { downloaded: e.downloaded, total: e.total } });
        break;
      // attention / terminal / navigate are UI concerns, handled in store/events.ts
      default:
        break;
    }
  },
}));

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
