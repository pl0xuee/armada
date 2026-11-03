import { useEffect, useRef } from "react";

/** True while the window is unfocused or hidden (see useWindowActivity). */
export const windowBlurred = () =>
  typeof document !== "undefined" && (document.documentElement.dataset.window === "blurred" || document.hidden);

/**
 * `setInterval` that skips its ticks while the window is blurred or hidden, and runs `fn` once as
 * soon as the window is visible again (so a refresh is not a whole period late). Returns the stop function.
 */
export function setVisibleInterval(fn: () => void, ms: number): () => void {
  const id = setInterval(() => {
    if (!windowBlurred()) fn();
  }, ms);
  let resume: ReturnType<typeof setTimeout> | undefined;
  let wasBlurred = windowBlurred();
  const onChange = () => {
    // Let useWindowActivity update the marker first (listener order is not guaranteed).
    clearTimeout(resume);
    resume = setTimeout(() => {
      const blurred = windowBlurred();
      if (wasBlurred && !blurred) fn();
      wasBlurred = blurred;
    }, 0);
  };
  if (typeof window !== "undefined") {
    window.addEventListener("focus", onChange);
    window.addEventListener("blur", onChange);
    document.addEventListener("visibilitychange", onChange);
  }
  return () => {
    clearInterval(id);
    clearTimeout(resume);
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", onChange);
      window.removeEventListener("blur", onChange);
      document.removeEventListener("visibilitychange", onChange);
    }
  };
}

/** React form of `setVisibleInterval`; `fn` may change every render. Does nothing while `enabled` is false. */
export function useVisibleInterval(fn: () => void, ms: number, enabled = true) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!enabled) return;
    return setVisibleInterval(() => latest.current(), ms);
  }, [ms, enabled]);
}
