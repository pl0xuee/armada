import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { BudgetStatus } from "@/lib/types";

const REFRESH_MS = 30_000;

/**
 * Today's spend against the daily budget. Re-read when `signal` changes (the fleet's total
 * cost) and every so often, since the day rolls over at local midnight.
 */
export function useBudgetStatus(signal: number): BudgetStatus | null {
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      api
        .budgetStatus()
        .then((s) => live && setStatus(s))
        .catch(() => {});
    // A burst of cost updates is read once.
    const soon = setTimeout(read, 400);
    const every = setInterval(read, REFRESH_MS);
    return () => {
      live = false;
      clearTimeout(soon);
      clearInterval(every);
    };
  }, [signal]);
  return status;
}
