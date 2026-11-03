import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * What the composer's toolbar shows at a fold step. Step 0 shows every session option; each step moves one more into
 * the ⚙ menu (the first, the mode, always stays); the next step drops the Stop / Send labels; the last one also hides
 * the working dot and the divider (the header still shows the dot).
 */
export function toolbarFold(options: number, step: number, tight: boolean) {
  const optionSteps = Math.max(0, options - 1);
  // A tight composer starts with one option inline and icon buttons, as it always has.
  const s = Math.max(step, tight ? optionSteps + 1 : 0);
  return {
    step: s,
    inline: options - Math.min(s, optionSteps),
    iconButtons: s > optionSteps,
    bare: s > optionSteps + 1,
    last: s > optionSteps + 1,
  };
}

/**
 * Whether the row's content runs past its padding. `scrollWidth` only grows once it passes the border, so when the
 * buttons on the right (`end`, pushed there with `ml-auto`) are known, their right edge is checked instead.
 */
function overflows(row: HTMLElement, end: HTMLElement | null) {
  if (!end) return row.scrollWidth > row.clientWidth + 1;
  const box = row.getBoundingClientRect();
  const contentRight =
    box.left + row.clientLeft + row.clientWidth - (parseFloat(getComputedStyle(row).paddingRight) || 0);
  return end.getBoundingClientRect().right > contentRight + 0.5;
}

/**
 * Folds the toolbar a step at a time until `rowRef` no longer overflows, before the browser paints, so it never spills
 * out of the composer whatever options the agent has. Narrowing keeps the folds made so far; widening, or a change in
 * what the row holds (`contentKey`), starts again from everything shown. The row's own width is measured each time
 * (a width passed in can lag a frame behind a panel opening, and a fold recorded against it would stick), and
 * `watchRef` (the buttons on the right) is checked again when it grows by itself.
 */
export function useToolbarFit(
  rowRef: RefObject<HTMLElement | null>,
  watchRef: RefObject<HTMLElement | null>,
  contentKey: string,
  options: number,
  tight: boolean,
) {
  const [rowWidth, setRowWidth] = useState(0);
  const [fit, setFit] = useState({ key: "", width: 0, step: 0 });
  const kept = fit.key === contentKey && rowWidth <= fit.width ? fit.step : 0;
  const fold = toolbarFold(options, kept, tight);
  const latest = useRef({ contentKey, fold });

  const check = () => {
    const row = rowRef.current;
    const cur = latest.current;
    if (!row) return;
    const w = row.clientWidth;
    setRowWidth(w);
    if (cur.fold.last || !overflows(row, watchRef.current)) return;
    setFit({ key: cur.contentKey, width: w, step: cur.fold.step + 1 });
  };
  // What was last put on screen, for `check` (which also runs from the observer).
  useLayoutEffect(() => {
    latest.current = { contentKey, fold };
  });
  // `check` reads the latest values through the ref; these are what can make the row overflow.
  useLayoutEffect(check, [contentKey, fold.step, fold.last]);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const ro = new ResizeObserver(check);
    ro.observe(row);
    if (watchRef.current) ro.observe(watchRef.current);
    return () => ro.disconnect();
    // Again when the row's content changes: the buttons may only now be on screen.
  }, [rowRef, watchRef, contentKey]);
  return fold;
}
