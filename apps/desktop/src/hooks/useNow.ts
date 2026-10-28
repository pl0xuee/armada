import { useSyncExternalStore } from "react";

// One shared ticker for all relative timestamps.
let now = Date.now();
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(cb: () => void) {
  subs.add(cb);
  timer ??= setInterval(() => {
    now = Date.now();
    for (const s of subs) s();
  }, 30_000);
  return () => {
    subs.delete(cb);
    if (subs.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}
