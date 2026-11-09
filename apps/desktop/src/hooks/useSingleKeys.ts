import { useApp } from "@/store/app";

/** Whether the one-letter shortcuts (A, D, J, K, E…) are on; key hints are shown only then. */
export function useSingleKeys(): boolean {
  return useApp((s) => s.settings?.singleKeyShortcuts !== false);
}
