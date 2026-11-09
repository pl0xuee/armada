import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { BudgetStatus } from "@/lib/types";
import { setVisibleInterval } from "./useVisibleInterval";

const REFRESH_MS = 30_000;

/**
 * Today's spend against the daily budget. Re-read when `signal` changes (the fleet's total
 * cost) and every so often, since the day rolls over at local midnight. With `enabled` false
 * (no daily limit to measure) nothing is read.
 */
export function useBudgetStatus(signal: number, enabled = true): BudgetStatus | null {
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const read = () =>
      api
        .budgetStatus()
        .then((s) => live && setStatus(s))
        .catch(() => {});
    // A burst of cost updates is read once.
    const soon = setTimeout(read, 400);
    const stopEvery = setVisibleInterval(read, REFRESH_MS);
    return () => {
      live = false;
      clearTimeout(soon);
      stopEvery();
    };
  }, [signal, enabled]);
  return enabled ? status : null;
}
