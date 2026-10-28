import { useEffect, useState } from "react";

/**
 * `value`, but a drop back to `empty` only takes effect after it has stayed that way for `ms`.
 * Smooths over brief gaps (e.g. an idle moment between a background sub-agent's turns).
 */
export function useHeld<T>(value: T, empty: T, ms: number): T {
  const [held, setHeld] = useState(value);
  const isEmpty = value === empty;
  useEffect(() => {
    if (!isEmpty) {
      setHeld(value);
      return;
    }
    const t = setTimeout(() => setHeld(empty), ms);
    return () => clearTimeout(t);
  }, [value, empty, isEmpty, ms]);
  return isEmpty ? held : value;
}

/** How long the "waiting on sub-agents" state outlives the last counted running sub-agent. */
export const WAITING_HOLD_MS = 6000;
