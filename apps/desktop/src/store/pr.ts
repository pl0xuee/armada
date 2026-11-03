import { create } from "zustand";
import { api } from "@/lib/api";
import type { PrStatus } from "@/lib/types";

interface PrState {
  byAgent: Record<string, PrStatus>;
}

export const usePr = create<PrState>(() => ({ byAgent: {} }));

const inflight = new Map<string, Promise<void>>();
// Per agent: the newest request started, and the newest one whose result was applied. A slow
// response never overwrites the result of a request that started after it (e.g. a forced refresh).
const started = new Map<string, number>();
const applied = new Map<string, number>();

/**
 * Fetches (cached by the backend) the PR + CI status of an agent's branch. Never throws and
 * never toasts: failures keep whatever status we already had.
 */
export function refreshPr(agentId: string, force = false): Promise<void> {
  const key = `${agentId}:${force}`;
  const running = inflight.get(key);
  if (running) return running;
  const seq = (started.get(agentId) ?? 0) + 1;
  started.set(agentId, seq);
  const p = api
    .prStatus(agentId, force)
    .then((status) => {
      if (seq < (applied.get(agentId) ?? 0)) return;
      applied.set(agentId, seq);
      const prev = usePr.getState().byAgent[agentId];
      // Keep the last good PR info across transient "unknown" results.
      if (status.state === "unknown" && prev?.state === "ok") return;
      usePr.setState((s) => ({ byAgent: { ...s.byAgent, [agentId]: status } }));
    })
    .catch(() => undefined)
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** After commit / push / create PR: look again right away, and once more shortly after (CI starts late). */
export function refreshPrSoon(agentId: string) {
  void refreshPr(agentId, true);
  setTimeout(() => void refreshPr(agentId, true), 8000);
}
