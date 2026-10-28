// Checkpoints (rewind points) per agent, shared by every message bubble. Fetched on demand
// and refreshed when the agent's status changes (a checkpoint is taken as each turn begins).
import { create } from "zustand";
import { api } from "@/lib/api";
import type { Checkpoint } from "@/lib/types";
import { useApp } from "./app";

interface Entry {
  available: boolean;
  /** Turn checkpoints by the id of the user message they precede. */
  byItem: Record<string, Checkpoint>;
}

export const useCheckpoints = create<{ byAgent: Record<string, Entry> }>(() => ({ byAgent: {} }));

const known = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const loadSeq = new Map<string, number>();

async function load(agentId: string) {
  const seq = (loadSeq.get(agentId) ?? 0) + 1;
  loadSeq.set(agentId, seq);
  try {
    const list = await api.listCheckpoints(agentId);
    if (loadSeq.get(agentId) !== seq) return; // a newer load superseded this one
    const byItem: Record<string, Checkpoint> = {};
    for (const c of list.checkpoints) if (c.kind === "turn" && c.itemId) byItem[c.itemId] = c;
    useCheckpoints.setState((s) => ({ byAgent: { ...s.byAgent, [agentId]: { available: list.available, byItem } } }));
    known.add(agentId);
  } catch {
    // Stay unknown so the next ensureCheckpoints retries; the feature just stays hidden meanwhile.
  } finally {
    if (loadSeq.get(agentId) === seq) inflight.delete(agentId);
  }
}

const inflight = new Set<string>();

/** Start tracking an agent's checkpoints (idempotent; retries after a failed first load). */
export function ensureCheckpoints(agentId: string) {
  if (known.has(agentId) || inflight.has(agentId)) return;
  inflight.add(agentId);
  void load(agentId);
}

export function refreshCheckpoints(agentId: string, delayMs = 0) {
  if (!known.has(agentId) && !inflight.has(agentId)) return;
  const prev = timers.get(agentId);
  if (prev) clearTimeout(prev);
  timers.set(
    agentId,
    setTimeout(() => {
      timers.delete(agentId);
      void load(agentId);
    }, delayMs),
  );
}

let last: Record<string, string> = {};
useApp.subscribe((s) => {
  const next: Record<string, string> = {};
  for (const id of known) {
    const a = s.agents[id];
    if (!a) {
      known.delete(id);
      continue;
    }
    next[id] = a.status;
    if (last[id] !== undefined && last[id] !== a.status) {
      // Taken right after a turn begins; refresh then and again once it has settled.
      refreshCheckpoints(id, a.status === "working" ? 1500 : 200);
    }
  }
  last = next;
});
