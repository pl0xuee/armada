import { create } from "zustand";
import { api } from "@/lib/api";
import type { McpServer } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

export type McpTestResult =
  | { state: "running"; fingerprint: string }
  | { state: "ok"; message: string; fingerprint: string }
  | { state: "error"; message: string; fingerprint: string };

/** Identity of everything that affects a connection (enabling/disabling doesn't). */
export function mcpFingerprint(s: Omit<McpServer, "id" | "enabled">): string {
  return JSON.stringify([s.name, s.transport, s.command, s.args, s.env, s.url, s.headers]);
}

interface McpTestStore {
  /** Results per server id (or a draft key); stale once the fingerprint changes. */
  results: Record<string, McpTestResult>;
  run: (key: string, server: McpServer) => Promise<void>;
}

export const useMcpTests = create<McpTestStore>((set, get) => ({
  results: {},
  run: async (key, server) => {
    const fingerprint = mcpFingerprint(server);
    set({ results: { ...get().results, [key]: { state: "running", fingerprint } } });
    let result: McpTestResult;
    try {
      result = { state: "ok", message: await api.testMcpServer(server), fingerprint };
    } catch (e) {
      result = { state: "error", message: errorMessage(e), fingerprint };
    }
    // Ignore results for a config that changed while the test ran.
    if (get().results[key]?.fingerprint === fingerprint) set({ results: { ...get().results, [key]: result } });
  },
}));

/** The cached result for this exact configuration, if any. */
export function useMcpTestResult(key: string, server: Omit<McpServer, "id" | "enabled">): McpTestResult | undefined {
  const r = useMcpTests((s) => s.results[key]);
  return r && r.fingerprint === mcpFingerprint(server) ? r : undefined;
}
