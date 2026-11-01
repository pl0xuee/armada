import { useSyncExternalStore } from "react";
import { storage } from "./storage";
import { loadGroups, withGroup } from "./together";

const KEY = "armada.together";
let groups: string[][] = loadGroups();
const listeners = new Set<() => void>();

/** Remember that these agents were started together (so the chip row can show them, even the one added from). */
export function rememberGroup(ids: readonly string[]) {
  groups = withGroup(groups, ids);
  storage.set(KEY, JSON.stringify(groups));
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
const snapshot = () => groups;

export function useRememberedGroups(): readonly (readonly string[])[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
