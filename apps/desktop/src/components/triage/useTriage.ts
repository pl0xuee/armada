import { useMemo } from "react";
import { create } from "zustand";
import { triageQueue, type NeedsReason } from "@/lib/agents";
import type { Agent } from "@/lib/types";
import { useApp, usePendingPermissions, usePendingQuestions } from "@/store/app";

interface TriageStore {
  selectedId: string | null;
  select: (id: string | null) => void;
}

export const useTriageStore = create<TriageStore>((set) => ({
  selectedId: null,
  select: (selectedId) => set({ selectedId }),
}));

export interface TriageEntry {
  agent: Agent;
  reason: NeedsReason;
}

function computeQueue(agents: Record<string, Agent>): TriageEntry[] {
  return triageQueue(Object.values(agents));
}

/** Agents that need the user (acknowledged ones stay hidden until they do something new). */
export function useTriageQueue(): TriageEntry[] {
  const agents = useApp((s) => s.agents);
  return useMemo(() => computeQueue(agents), [agents]);
}

/** Non-hook snapshot of the queue (keyboard shortcuts). */
export function triageQueueNow(): TriageEntry[] {
  return computeQueue(useApp.getState().agents);
}

/** Advance the selection to the next queued agent (Ctrl/⌘+J while the view is open). */
export function selectNextTriage(queue: TriageEntry[]) {
  const { selectedId, select } = useTriageStore.getState();
  if (queue.length === 0) return;
  const i = queue.findIndex((e) => e.agent.id === selectedId);
  select(queue[(i + 1) % queue.length].agent.id);
}

export const REASON_LABEL: Record<NeedsReason, string> = {
  permission: "Needs approval",
  rate_limited: "Usage limit",
  error: "Error",
  done: "Done · unread",
};

/** The pill text: a question is not an approval, so it reads "Needs you". */
export function reasonLabel(reason: NeedsReason, asksQuestion = false): string {
  return asksQuestion && reason === "permission" ? "Needs you" : REASON_LABEL[reason];
}

/** Agents whose blocker is a question (an approval request, if both, comes first). */
export function useQuestionAgents(): ReadonlySet<string> {
  const questions = usePendingQuestions();
  const permissions = usePendingPermissions();
  return useMemo(() => {
    const approving = new Set(permissions.map((p) => p.agent.id));
    return new Set(questions.filter((q) => !approving.has(q.agent.id)).map((q) => q.agent.id));
  }, [questions, permissions]);
}

export const REASON_TONE: Record<NeedsReason, string> = {
  permission: "border-warn/35 bg-warn/10 text-warn",
  rate_limited: "border-warn/35 bg-warn/10 text-warn",
  error: "border-err/35 bg-err/10 text-err",
  done: "border-ok/30 bg-ok/10 text-ok",
};

/** Just the queue length (cheap subscription for badges and the window title). */
export function useTriageCount(): number {
  return useApp((s) => computeQueue(s.agents).length);
}
