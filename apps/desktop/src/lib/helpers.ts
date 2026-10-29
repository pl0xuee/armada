// Helper agents: pure logic for the busy-send decision, tiling and sidebar nesting.
import type { Agent, BusySend, HelperSync } from "./types";

// ---------------------------------------------------------------- busy send

/** How the user triggered a send while the agent was busy. */
export type BusyIntent = "enter" | "queueButton" | "modEnter" | "helperMenu" | "queueMenu";
export type BusyDecision = "queue" | "helper" | "ask";

/** Helpers can't start helpers of their own: from one, everything queues. */
export function canStartHelper(agent: Pick<Agent, "parentId" | "running" | "status">): boolean {
  return !agent.parentId && agent.running && agent.status !== "interrupted" && agent.status !== "stopped";
}

/**
 * What to do with a message sent while the agent is busy. Explicit "helper" gestures (Ctrl/⌘+Enter, the
 * split-button menu) always start a helper; plain sends follow the user's setting.
 */
export function decideBusySend(setting: BusySend, intent: BusyIntent, helperAllowed = true): BusyDecision {
  if (!helperAllowed || intent === "queueMenu") return "queue";
  if (intent === "modEnter" || intent === "helperMenu") return "helper";
  return setting;
}

// ---------------------------------------------------------------- grouping

export interface HelperGroup {
  main: Agent;
  helpers: Agent[];
}

/** Live (not archived) helpers of an agent, oldest first. */
export function helpersOf(agents: readonly Agent[], mainId: string): Agent[] {
  return agents
    .filter((a) => a.parentId === mainId && !a.archived)
    .sort((x, y) => x.createdAt - y.createdAt || x.id.localeCompare(y.id));
}

/** The main agent and live helpers `id` belongs to, or null when it has none (a plain agent). */
export function helperGroupOf(agents: readonly Agent[], id: string): HelperGroup | null {
  const me = agents.find((a) => a.id === id);
  if (!me) return null;
  const main = me.parentId ? agents.find((a) => a.id === me.parentId) : me;
  if (!main) return null;
  const helpers = helpersOf(agents, main.id);
  if (helpers.length === 0) return null;
  // An archived helper opened on its own is a single pane, not part of the live group.
  if (me.parentId && !helpers.some((h) => h.id === me.id)) return null;
  return { main, helpers };
}

/** A helper that needs the user must stay findable in the "Needs you" group, not hidden under its main. */
function needsAttention(a: Agent): boolean {
  return a.status === "needs_permission" || a.status === "error" || a.status === "interrupted" || a.pendingPermissions > 0;
}

/**
 * Sidebar: helpers nest under their main agent when both are archived or both are not, except
 * helpers that need attention (those surface as their own rows).
 */
export function nestHelpers(agents: readonly Agent[]): { roots: Agent[]; children: Map<string, Agent[]> } {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const roots: Agent[] = [];
  const children = new Map<string, Agent[]>();
  for (const a of agents) {
    const parent = a.parentId ? byId.get(a.parentId) : undefined;
    if (parent && !parent.parentId && parent.archived === a.archived && !needsAttention(a)) {
      const list = children.get(parent.id) ?? [];
      list.push(a);
      children.set(parent.id, list);
    } else {
      roots.push(a);
    }
  }
  for (const list of children.values()) list.sort((x, y) => x.createdAt - y.createdAt || x.id.localeCompare(y.id));
  return { roots, children };
}

// ---------------------------------------------------------------- tiling

export const TILE_MIN_WIDTH = 360;

/** How many tiles fit side by side. */
export function tileCapacity(width: number, min = TILE_MIN_WIDTH): number {
  return Math.max(1, Math.floor(width / min));
}

/**
 * Which tiles are shown when not all fit. `ids` has the main agent first. The focused tile is always
 * visible (it takes the last slot if it would otherwise overflow); the rest keep their order.
 */
export function planTiles(
  ids: readonly string[],
  focusId: string,
  capacity: number,
): { visible: string[]; hidden: string[] } {
  const cap = Math.max(1, capacity);
  if (ids.length <= cap) return { visible: [...ids], hidden: [] };
  let visible = ids.slice(0, cap);
  if (!visible.includes(focusId) && ids.includes(focusId)) {
    visible = [...visible.slice(0, cap - 1), focusId];
    visible.sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
  }
  return { visible, hidden: ids.filter((id) => !visible.includes(id)) };
}

/** Drag divider `index` (between tile index and index+1) by `delta` px; both neighbours keep `min`. */
export function resizeTiles(widths: readonly number[], index: number, delta: number, min = TILE_MIN_WIDTH): number[] {
  if (index < 0 || index >= widths.length - 1) return [...widths];
  const out = [...widths];
  const pair = out[index] + out[index + 1];
  const left = Math.min(Math.max(out[index] + delta, Math.min(min, pair / 2)), pair - Math.min(min, pair / 2));
  out[index] = left;
  out[index + 1] = pair - left;
  return out;
}

// ---------------------------------------------------------------- sync chip

export type SyncTone = "ok" | "busy" | "wait" | "warn";

export interface SyncPresentation {
  label: string;
  tone: SyncTone;
}

/** Text for the sync chip: `mainName` is the main agent's short name. */
export function syncPresentation(sync: HelperSync, mainName: string): SyncPresentation {
  switch (sync.state) {
    case "inSync":
      return { label: sync.files > 0 ? `In sync · ${sync.files} file${sync.files === 1 ? "" : "s"}` : "In sync", tone: "ok" };
    case "merging":
      return { label: "Merging…", tone: "busy" };
    case "pendingToMain":
      return { label: `Waiting for ${mainName} to finish`, tone: "wait" };
    case "pendingFromMain":
      return { label: `Getting ${mainName}’s changes…`, tone: "wait" };
    case "conflict":
      return { label: "Conflict", tone: "warn" };
  }
}
