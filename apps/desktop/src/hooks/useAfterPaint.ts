import { startTransition, useEffect, useState } from "react";

let painted = false;

/**
 * False for the first commit of the app, true once it has been painted (and for every later mount).
 * Lets a big, non-critical subtree (the agent list) join the second frame instead of the first, so the
 * boot render doesn't land as one long task.
 */
export function useAfterPaint(): boolean {
  const [ready, setReady] = useState(painted);
  useEffect(() => {
    if (ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // rAF runs before the paint of the first frame; the timer after it.
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        painted = true;
        startTransition(() => setReady(true));
      }, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [ready]);
  return ready;
}
