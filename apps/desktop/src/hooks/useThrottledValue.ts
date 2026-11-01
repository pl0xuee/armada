import { useEffect, useMemo, useState } from "react";
import { createThrottle } from "@/lib/throttle";

/**
 * `value`, refreshed at most once per `ms` while `active`. When `active` ends the live value is
 * returned in that same render, so nothing is ever left stale.
 */
export function useThrottledValue<T>(value: T, ms: number, active: boolean): T {
  const [shown, setShown] = useState(value);
  const throttle = useMemo(() => createThrottle<T>(ms, setShown), [ms]);
  useEffect(() => {
    if (active) throttle.push(value);
    else throttle.flush(value);
  }, [throttle, value, active]);
  useEffect(() => () => throttle.cancel(), [throttle]);
  return active ? shown : value;
}
