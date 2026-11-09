import { create } from "zustand";
import { api } from "@/lib/api";
import type { CompanionInfo } from "@/lib/types";

interface CompanionStore {
  /** null until the first check finishes. */
  list: CompanionInfo[] | null;
  loading: boolean;
  /**
   * Looks again at what is installed. A check already running is not started twice, unless
   * `fresh`: after an install, one that started before it finished may miss the tool.
   */
  refresh: (fresh?: boolean) => Promise<CompanionInfo[]>;
}

export const useCompanions = create<CompanionStore>((set, get) => {
  let running: Promise<CompanionInfo[]> | null = null;
  return {
    list: null,
    loading: false,
    refresh: (fresh) => {
      if (running && fresh) {
        const after = () => get().refresh();
        return running.then(after, after);
      }
      if (running) return running;
      set({ loading: true });
      running = api
        .listCompanions()
        .then((list) => {
          set({ list });
          return list;
        })
        .finally(() => {
          running = null;
          set({ loading: false });
        });
      return running;
    },
  };
});
