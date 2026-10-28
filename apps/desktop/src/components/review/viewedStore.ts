import { create } from "zustand";
import type { ParsedFileDiff } from "@/lib/diff";

/** Content fingerprint: a file marked viewed un-marks itself when the agent changes it again. */
export function fileSignature(f: ParsedFileDiff): string {
  return `${f.additions}:${f.deletions}:${f.hunks.map((h) => h.header).join("|")}`;
}

interface ViewedStore {
  /** agentId → path → signature at the time it was marked viewed (in memory, per app session). */
  byAgent: Record<string, Record<string, string>>;
  toggle: (agentId: string, path: string, signature: string) => void;
}

export const useViewedFiles = create<ViewedStore>((set) => ({
  byAgent: {},
  toggle: (agentId, path, signature) =>
    set((s) => {
      const cur = { ...(s.byAgent[agentId] ?? {}) };
      if (cur[path] === signature) delete cur[path];
      else cur[path] = signature;
      return { byAgent: { ...s.byAgent, [agentId]: cur } };
    }),
}));

const NONE: Record<string, string> = {};

export function useAgentViewed(agentId: string): Record<string, string> {
  return useViewedFiles((s) => s.byAgent[agentId] ?? NONE);
}
