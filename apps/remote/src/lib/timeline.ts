/**
 * Pure timeline operations: ordering, upserts, offset-checked streaming
 * deltas, and merging a fetched snapshot with events that arrived while the
 * fetch was in flight. Kept free of app state so it can be unit-tested.
 */
import type { TextDeltaEvent, TimelineItem } from "./types";

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

export function sortItems(items: TimelineItem[]): TimelineItem[] {
  return items.slice().sort((a, b) => a.seq - b.seq);
}

export type DeltaOutcome =
  /** Applied (appended, or replaced a diverging tail). */
  | "applied"
  /** Already contained in our copy; nothing changed. */
  | "duplicate"
  /** Our copy is missing text before this delta (or the item itself): refetch. */
  | "gap";

/**
 * Apply one streamed chunk to a string field, using the server's `offset`
 * (the field's length in UTF-16 units before the chunk):
 * - offset === length: append;
 * - offset <  length: already seen if our copy has the chunk there, else our
 *   tail diverged and is replaced;
 * - offset >  length: we missed something; don't guess.
 */
export function applyTextDelta(cur: string, offset: number, delta: string): { text: string; outcome: DeltaOutcome } {
  if (!Number.isInteger(offset) || offset < 0) return { text: cur, outcome: "gap" };
  if (offset === cur.length) return { text: cur + delta, outcome: "applied" };
  if (offset < cur.length) {
    if (cur.startsWith(delta, offset)) return { text: cur, outcome: "duplicate" };
    return { text: cur.slice(0, offset) + delta, outcome: "applied" };
  }
  return { text: cur, outcome: "gap" };
}

type Delta = Pick<TextDeltaEvent, "itemId" | "field" | "delta" | "offset">;

export function applyDelta(items: TimelineItem[], ev: Delta): { items: TimelineItem[]; outcome: DeltaOutcome } {
  const idx = items.findIndex((i) => i.id === ev.itemId);
  if (idx < 0) return { items, outcome: "gap" };
  const it = items[idx];
  let updated: TimelineItem;
  let outcome: DeltaOutcome;
  if (ev.field === "output" && it.kind === "tool_call") {
    const r = applyTextDelta(it.output, ev.offset, ev.delta);
    if (r.outcome !== "applied") return { items, outcome: r.outcome };
    updated = { ...it, output: r.text };
    outcome = r.outcome;
  } else if (ev.field === "text" && (it.kind === "agent_message" || it.kind === "thought" || it.kind === "user_message")) {
    const r = applyTextDelta(it.text, ev.offset, ev.delta);
    if (r.outcome !== "applied") return { items, outcome: r.outcome };
    updated = { ...it, text: r.text };
    outcome = r.outcome;
  } else {
    // Field doesn't exist on this kind: nothing sensible to do.
    return { items, outcome: "duplicate" };
  }
  const next = items.slice();
  next[idx] = updated;
  return { items: next, outcome };
}

const TOOL_RANK = { pending: 0, in_progress: 1, completed: 2, failed: 2 } as const;
const PLAN_RANK = { pending: 0, in_progress: 1, completed: 2 } as const;

/**
 * Whether `candidate` (an upsert received while a snapshot was being fetched)
 * is at least as far along as `base` (the snapshot's copy). Items carry no
 * revision, so progress is judged per kind; ties count as "as complete".
 */
export function isAtLeastAsComplete(candidate: TimelineItem, base: TimelineItem): boolean {
  if (candidate.kind !== base.kind) return true;
  switch (candidate.kind) {
    case "user_message":
    case "agent_message":
    case "thought":
      return candidate.text.length >= (base as typeof candidate).text.length;
    case "tool_call": {
      const b = base as typeof candidate;
      const cr = TOOL_RANK[candidate.status] ?? 0;
      const br = TOOL_RANK[b.status] ?? 0;
      return cr > br || (cr === br && candidate.output.length >= b.output.length);
    }
    case "permission":
      return (base as typeof candidate).resolution === null || candidate.resolution !== null;
    case "question":
      return (base as typeof candidate).resolution === null || candidate.resolution !== null;
    case "plan": {
      const score = (e: typeof candidate.entries) => e.reduce((n, x) => n + (PLAN_RANK[x.status] ?? 0), 0);
      return score(candidate.entries) >= score((base as typeof candidate).entries);
    }
    default:
      return true;
  }
}

export type BufferedEvent = { type: "item_upserted"; item: TimelineItem } | ({ type: "text_delta" } & Delta);

/**
 * Combine a fetched snapshot with the events received while it was in flight.
 * Upserts never replace a more complete snapshot item; deltas go through the
 * offset rules, so ones already in the snapshot are skipped and newer ones
 * apply. `gap` means something can't be reconciled and the caller should refetch.
 */
export function mergeSnapshot(snapshot: TimelineItem[], buffered: BufferedEvent[]): { items: TimelineItem[]; gap: boolean } {
  let items = sortItems(snapshot);
  let gap = false;
  for (const ev of buffered) {
    if (ev.type === "item_upserted") {
      const cur = items.find((i) => i.id === ev.item.id);
      if (!cur || isAtLeastAsComplete(ev.item, cur)) items = upsertItem(items, ev.item);
    } else {
      const r = applyDelta(items, ev);
      items = r.items;
      if (r.outcome === "gap") gap = true;
    }
  }
  return { items, gap };
}
