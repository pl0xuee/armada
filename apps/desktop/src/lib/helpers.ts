// Helper agents: pure logic for the busy-send decision, tiling and sidebar nesting.
import type { Agent, BusySend, HelperSync } from "./types";

// ---------------------------------------------------------------- busy send

/** How the user triggered a send while the agent was busy. */
export type BusyIntent = "enter" | "queueButton" | "modEnter" | "helperMenu" | "queueMenu" | "deliverMenu";
/** `deliver`: into the running turn; `queue`: after it ends; `helper`: a parallel helper agent. */
export type BusyDecision = "deliver" | "queue" | "helper";

/** Helpers can't start helpers of their own: from one, everything queues. */
export function canStartHelper(agent: Pick<Agent, "parentId" | "running" | "status">): boolean {
  return !agent.parentId && agent.running && agent.status !== "interrupted" && agent.status !== "stopped";
}

/**
 * What to do with a message sent while the agent is busy. Explicit gestures win: Ctrl/⌘+Enter and the
 * menu's helper item start a helper, its queue item queues, its deliver item delivers. Plain sends follow
 * the user's setting: "deliver" (and the old "ask") hands the message to the running turn like Claude
 * Code does when the agent can take it (`canDeliver`), else queues it; "queue" holds it for after the
 * turn; "helper" starts a helper. Whatever can't be done (no helper allowed, no mid-turn delivery) falls
 * back to the next safest thing, never to stopping the turn.
 */
export function decideBusySend(
  setting: BusySend | "ask",
  intent: BusyIntent,
  helperAllowed = true,
  canDeliver = false,
): BusyDecision {
  const fallback: BusyDecision = canDeliver ? "deliver" : "queue";
  if (intent === "queueMenu") return "queue";
  if (intent === "deliverMenu") return fallback;
  if ((intent === "modEnter" || intent === "helperMenu") && helperAllowed) return "helper";
  if (setting === "queue") return "queue";
  if (setting === "helper" && helperAllowed) return "helper";
  return fallback;
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
  return (
    a.status === "needs_permission" || a.status === "error" || a.status === "interrupted" || a.pendingPermissions > 0
  );
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

/** Most agents shown together in one grid. */
export const MAX_TILES = 8;

/** Columns that look right for `n` agents: 2 → 2, 3 → 3, 4 → 2×2, 5–6 → 3×2, 7+ → 4 wide. */
export function idealTileColumns(n: number): number {
  return n <= 3 ? Math.max(1, n) : n === 4 ? 2 : n <= 6 ? 3 : 4;
}

/**
 * The grid for `n` agents in `width` px: as many columns as look right, but never narrower than
 * `min` px each. One column (`cols` 1) means the agents don't fit side by side and go behind tabs.
 */
export function tileGrid(n: number, width: number, min = TILE_MIN_WIDTH): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  const cols = Math.max(1, Math.min(tileCapacity(width, min), idealTileColumns(n)));
  return { cols, rows: Math.ceil(n / cols) };
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/**
 * Where each of `n` tiles goes in a `cols`-wide grid. Full rows share the width equally; a shorter
 * last row stretches to fill it (no hole), on a finer column track of `units` per row. Cells are in
 * tile order, rows and columns 1-based.
 */
export function tilePlacement(
  n: number,
  cols: number,
): { units: number; rows: number; cells: { row: number; col: number; span: number }[] } {
  const c = Math.max(1, cols);
  const rows = Math.max(1, Math.ceil(n / c));
  const rest = n % c;
  const lastLen = n > 0 && rest > 0 ? rest : c;
  const units = (c * lastLen) / gcd(c, lastLen);
  const cells = Array.from({ length: n }, (_, i) => {
    const row = Math.floor(i / c) + 1;
    const perRow = row === rows ? lastLen : c;
    const span = units / perRow;
    return { row, col: (i % c) * span + 1, span };
  });
  return { units, rows, cells };
}

/**
 * The agents shown together when `selectedId` is open: the explicit group (agents started together,
 * or put together by hand) if it contains it, else the main agent and its helpers (when tiling them
 * is on), else just the one. Archived and deleted agents drop out (the open one stays).
 */
export function tileIdsFor(
  agents: Readonly<Record<string, Agent>>,
  selectedId: string | null,
  tileGroup: readonly string[] | null,
  tileHelpers: boolean,
): string[] {
  if (!selectedId || !agents[selectedId]) return [];
  if (tileGroup?.includes(selectedId)) {
    const live = tileGroup.filter((id) => agents[id] && (id === selectedId || !agents[id].archived));
    if (live.length > 1) return live;
  }
  if (tileHelpers) {
    const g = helperGroupOf(Object.values(agents), selectedId);
    if (g) return [g.main.id, ...g.helpers.map((h) => h.id)];
  }
  return [selectedId];
}

/**
 * Where focus goes when `removedId` (deleted) leaves the agents shown together: its neighbour in the
 * group, the next one first, skipping agents that are gone or archived. null when there is none.
 */
export function tileNeighbour(
  agents: Readonly<Record<string, Agent>>,
  tileGroup: readonly string[] | null,
  removedId: string,
): string | null {
  const i = tileGroup ? tileGroup.indexOf(removedId) : -1;
  if (!tileGroup || i < 0) return null;
  const usable = (id: string) => id !== removedId && !!agents[id] && !agents[id].archived;
  return tileGroup.slice(i + 1).find(usable) ?? tileGroup.slice(0, i).reverse().find(usable) ?? null;
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
      return {
        label: sync.files > 0 ? `In sync · ${sync.files} file${sync.files === 1 ? "" : "s"}` : "In sync",
        tone: "ok",
      };
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
