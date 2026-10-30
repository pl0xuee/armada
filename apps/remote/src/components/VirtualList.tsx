/**
 * Windowed list for long timelines, scrolled by the page itself (so the
 * sticky header/composer, iOS toolbars and keyboard behave natively).
 *
 * Only rows within OVERSCAN px of the viewport are mounted. Row heights start
 * as estimates and are replaced by measurements (ResizeObserver). When a row
 * entirely above the viewport turns out taller or shorter than assumed, the
 * scroll position is corrected by the difference so the content being read
 * doesn't move. Browser scroll anchoring is disabled (`overflow-anchor: none`)
 * so the two mechanisms don't fight.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { scrollByProgrammatic } from "@/lib/scroll";
import { prefixSums, visibleRange } from "@/lib/virtual";

const OVERSCAN = 600;
const INITIAL_ROWS = 24;

type Measure = { heights: Map<string, number>; estimates: Map<string, number> };

export function VirtualList<T>({
  items,
  getKey,
  estimate,
  render,
  onReachTop,
}: {
  items: T[];
  /** The first rows are on screen (load older items). */
  onReachTop?: () => void;
  getKey: (item: T) => string;
  /** Height guess (px) for a row that hasn't been measured yet. */
  estimate: (item: T) => number;
  render: (item: T) => ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const m = useRef<Measure>({ heights: new Map(), estimates: new Map() });
  const [version, setVersion] = useState(0);
  // Timelines open at the bottom, so start with the last rows mounted.
  const [range, setRange] = useState<[number, number]>(() => [Math.max(0, items.length - INITIAL_ROWS), items.length]);

  // Scroll corrections can't use window.scrollBy while the user is scrolling:
  // on iOS that cancels momentum. Instead they're applied as a visual offset of
  // the rendered block (`bias`) and folded into the scroll position once the
  // scroll ends.
  const block = useRef<HTMLDivElement>(null);
  const baseTop = useRef(0);
  const bias = useRef(0);
  const scroll = useRef({ last: 0, touching: false });
  const applyTransform = () => {
    if (block.current) block.current.style.transform = `translateY(${baseTop.current - bias.current}px)`;
  };

  const [ro] = useState(() =>
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
          let changed = false;
          let correction = 0;
          // Rows hidden under the sticky header count as above the viewport.
          const topEdge = document.querySelector("header")?.getBoundingClientRect().bottom ?? 0;
          for (const e of entries) {
            const el = e.target as HTMLElement;
            const key = el.dataset.vkey;
            if (!key || !el.isConnected) continue;
            const h = e.borderBoxSize?.[0]?.blockSize ?? el.getBoundingClientRect().height;
            const prev = m.current.heights.get(key) ?? m.current.estimates.get(key);
            if (prev !== undefined && Math.abs(prev - h) < 0.5) {
              m.current.heights.set(key, h);
              continue;
            }
            m.current.heights.set(key, h);
            changed = true;
            if (prev !== undefined && el.getBoundingClientRect().bottom <= topEdge) correction += h - prev;
          }
          // Shrinking above the viewport while at the very bottom (a finished run folding into one line):
          // the browser already moved the scroll position up by the same amount (it clamps to the new
          // bottom), so correcting again would shift the content the reader is looking at.
          if (correction < 0 && document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 2) correction = 0;
          if (correction) {
            const s = scroll.current;
            if (s.touching || performance.now() - s.last < 120) {
              bias.current += correction;
              applyTransform();
            } else scrollByProgrammatic(correction);
          }
          if (changed) setVersion((v) => v + 1);
        }),
  );
  useEffect(() => () => ro?.disconnect(), [ro]);

  const keys = useMemo(() => items.map(getKey), [items, getKey]);
  const offsets = useMemo(() => {
    const { heights, estimates } = m.current;
    return prefixSums(items.length, (i) => {
      const k = keys[i];
      const h = heights.get(k);
      if (h !== undefined) return h;
      // Estimates are computed once per row: recomputing them for thousands of
      // unmeasured rows on every layout change would dominate fast scrolls.
      let est = estimates.get(k);
      if (est === undefined) {
        est = estimate(items[i]);
        estimates.set(k, est);
      }
      return est;
    });
    // `version` changes when measurements do.
  }, [items, keys, estimate, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = offsets[items.length] ?? 0;

  const widen = useRef(0);
  const update = useCallback(() => {
    const el = container.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    const full = visibleRange(offsets, -top, -top + window.innerHeight, OVERSCAN);
    setRange((r) => {
      if (r[0] === full[0] && r[1] === full[1]) return r;
      // A far jump (scrubbing, "jump to top"): mount just what's on screen this
      // frame and add the overscan right after, instead of ~3 screens at once.
      if (full[1] <= r[0] || full[0] >= r[1]) {
        cancelAnimationFrame(widen.current);
        widen.current = requestAnimationFrame(() => setRange(full));
        return visibleRange(offsets, -top, -top + window.innerHeight, 0);
      }
      return full;
    });
  }, [offsets]);
  useEffect(() => () => cancelAnimationFrame(widen.current), []);

  useLayoutEffect(update, [update]);

  // Near the top: ask for older items (the controller ignores repeats).
  const reachTop = useRef(onReachTop);
  reachTop.current = onReachTop;
  useEffect(() => {
    if (range[0] === 0 && items.length) reachTop.current?.();
  }, [range, items.length]);

  // Older items were prepended: shift the window to the same rows and keep
  // them where they were on screen.
  const prevKeys = useRef(keys);
  useLayoutEffect(() => {
    const old = prevKeys.current;
    prevKeys.current = keys;
    if (!old.length || old === keys || keys[0] === old[0]) return;
    const k = keys.indexOf(old[0]);
    if (k <= 0) return;
    setRange((r) => [r[0] + k, r[1] + k]);
    const added = offsets[k] ?? 0;
    const s = scroll.current;
    if (s.touching || performance.now() - s.last < 120) {
      bias.current += added;
      applyTransform();
    } else scrollByProgrammatic(added);
  }, [keys, offsets]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let raf = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const fold = () => {
      clearTimeout(idle);
      if (!bias.current || scroll.current.touching) return;
      const b = bias.current;
      bias.current = 0;
      applyTransform();
      scrollByProgrammatic(b); // same frame as the transform reset: no visible jump
    };
    const schedule = () => {
      scroll.current.last = performance.now();
      clearTimeout(idle);
      idle = setTimeout(fold, 150);
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), update()));
    };
    const touchStart = () => (scroll.current.touching = true);
    const touchEnd = () => {
      scroll.current.touching = false;
      clearTimeout(idle);
      idle = setTimeout(fold, 150);
    };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("scrollend", fold, { passive: true });
    window.addEventListener("touchstart", touchStart, { passive: true });
    window.addEventListener("touchend", touchEnd, { passive: true });
    window.addEventListener("touchcancel", touchEnd, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(idle);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scrollend", fold);
      window.removeEventListener("touchstart", touchStart);
      window.removeEventListener("touchend", touchEnd);
      window.removeEventListener("touchcancel", touchEnd);
    };
  }, [update]);

  // Drop measurements of rows that are gone (e.g. after a refetch).
  useEffect(() => {
    const { heights, estimates } = m.current;
    if (heights.size <= keys.length * 1.5) return;
    const live = new Set(keys);
    for (const k of heights.keys()) if (!live.has(k)) heights.delete(k);
    for (const k of estimates.keys()) if (!live.has(k)) estimates.delete(k);
  }, [keys]);

  const n = items.length;
  const start = Math.min(range[0], Math.max(0, n - 1));
  const end = Math.min(n, Math.max(start + 1, range[1]));

  return (
    <div ref={container} className="relative" style={{ height: total }}>
      <div ref={block} className="absolute inset-x-0 top-0" style={{ transform: `translateY(${(baseTop.current = offsets[start] ?? 0) - bias.current}px)` }}>
        {items.slice(start, end).map((item, i) => {
          const key = keys[start + i];
          return (
            <Measured key={key} vkey={key} ro={ro}>
              {render(item)}
            </Measured>
          );
        })}
      </div>
    </div>
  );
}

const Measured = memo(function Measured({ vkey, ro, children }: { vkey: string; ro: ResizeObserver | null; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !ro) return;
    ro.observe(el);
    return () => ro.unobserve(el);
  }, [ro]);
  return (
    <div ref={ref} data-vkey={vkey} className="pb-4">
      {children}
    </div>
  );
});
