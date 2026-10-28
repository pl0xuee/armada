import { useState } from "react";
import { useNow } from "@/hooks/useNow";

/**
 * The shared clock ticks every 30 s; a view opened mid-interval would show times up to
 * 30 s stale. Start from the real time at mount, then follow the shared tick.
 */
export function useFreshNow(): number {
  const tick = useNow();
  const [mountedAt] = useState(() => Date.now());
  return Math.max(tick, mountedAt);
}
