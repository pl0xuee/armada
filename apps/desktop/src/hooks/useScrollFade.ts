import { useEffect, type RefObject } from "react";

/**
 * Drives the `.scroll-fade` mask of a scroller: each edge fades in over the first `size` px you
 * scroll away from it. Writes CSS variables directly, so scrolling never re-renders React.
 */
export function useScrollFade(ref: RefObject<HTMLElement | null>, size = 18) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    let lastTop = "";
    let lastBottom = "";
    const update = () => {
      raf = 0;
      const below = el.scrollHeight - el.clientHeight - el.scrollTop;
      const top = `${Math.round(Math.max(0, Math.min(size, el.scrollTop)))}px`;
      const bottom = `${Math.round(Math.max(0, Math.min(size, below)))}px`;
      // Most updates (a pane following a stream) change nothing; a style write would still invalidate the mask.
      if (top !== lastTop) el.style.setProperty("--fade-top", (lastTop = top));
      if (bottom !== lastBottom) el.style.setProperty("--fade-bottom", (lastBottom = bottom));
    };
    const schedule = () => {
      raf ||= requestAnimationFrame(update);
    };
    update();
    el.addEventListener("scroll", schedule, { passive: true });
    // The content grows and shrinks (streaming, sections appearing) without the scroller resizing.
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => {
      el.removeEventListener("scroll", schedule);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ref, size]);
}
