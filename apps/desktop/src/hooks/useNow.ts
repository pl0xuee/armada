import { useSyncExternalStore } from "react";
import { setVisibleInterval } from "./useVisibleInterval";

// One shared ticker for all relative timestamps.
let now = Date.now();
const subs = new Set<() => void>();
let stopTimer: (() => void) | null = null;

function subscribe(cb: () => void) {
  // The ticker stops with the last subscriber, so `now` is as old as that stop: refresh it for the first one back.
  if (subs.size === 0) now = Date.now();
  subs.add(cb);
  stopTimer ??= setVisibleInterval(() => {
    now = Date.now();
    for (const s of subs) s();
  }, 30_000);
  return () => {
    subs.delete(cb);
    if (subs.size === 0 && stopTimer) {
      stopTimer();
      stopTimer = null;
    }
  };
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}
