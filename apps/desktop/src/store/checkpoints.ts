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

async function load(agentId: string) {
  try {
    const list = await api.listCheckpoints(agentId);
    const byItem: Record<string, Checkpoint> = {};
    for (const c of list.checkpoints) if (c.kind === "turn" && c.itemId) byItem[c.itemId] = c;
    useCheckpoints.setState((s) => ({ byAgent: { ...s.byAgent, [agentId]: { available: list.available, byItem } } }));
  } catch {
    /* the feature just stays hidden */
  }
}

/** Start tracking an agent's checkpoints (idempotent). */
export function ensureCheckpoints(agentId: string) {
  if (known.has(agentId)) return;
  known.add(agentId);
  void load(agentId);
}

export function refreshCheckpoints(agentId: string, delayMs = 0) {
  if (!known.has(agentId)) return;
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
