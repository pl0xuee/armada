import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  clampOffset,
  isZeroOffset,
  loadOffset,
  nudgeFor,
  offsetTransform,
  saveOffset,
  sameOffset,
  ZERO_OFFSET,
  type PanelOffset,
} from "@/lib/panelPosition";

/** Targets inside the drag area that keep their own click behaviour. */
const NO_DRAG = "button:not([data-grip]), a, input, textarea, select, [data-no-drag]";

/**
 * Lets a bottom-right anchored panel be dragged by a handle area. The position is an offset from the
 * anchor applied as `transform: translate3d` straight on the element (no React render and no layout
 * per frame); it is committed and stored when the pointer is released. The panel stays inside the
 * window, also after the window or the panel itself resizes. Stored intent is never overwritten by a
 * temporary clamp, so a panel pushed in by a small window returns when the window grows again.
 */
export function usePanelDrag() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const intent = useRef<PanelOffset>(ZERO_OFFSET); // what the user chose
  const applied = useRef<PanelOffset>(ZERO_OFFSET); // what is on screen (clamped)
  const drag = useRef<{ id: number; startX: number; startY: number; from: PanelOffset } | null>(null);
  const frame = useRef(0);
  const [moved, setMoved] = useState(() => !isZeroOffset(loadOffset()));

  const apply = useCallback((want: PanelOffset) => {
    const el = wrapRef.current;
    if (!el) return ZERO_OFFSET;
    const r = el.getBoundingClientRect();
    const cur = applied.current;
    const base = { left: r.left - cur.x, top: r.top - cur.y, width: r.width, height: r.height };
    const next = clampOffset(want, base, {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    });
    if (!sameOffset(next, cur) || !el.style.transform) {
      el.style.transform = offsetTransform(next);
      applied.current = next;
    }
    return next;
  }, []);

  const commit = useCallback(
    (want: PanelOffset) => {
      const next = apply(want);
      intent.current = next;
      saveOffset(next);
      setMoved(!isZeroOffset(next));
    },
    [apply],
  );

  useLayoutEffect(() => {
    intent.current = loadOffset();
    apply(intent.current);
  }, [apply]);

  useEffect(() => {
    const refit = () => apply(drag.current ? applied.current : intent.current);
    window.addEventListener("resize", refit);
    const el = wrapRef.current;
    const ro = typeof ResizeObserver === "undefined" || !el ? null : new ResizeObserver(refit);
    ro?.observe(el!);
    return () => {
      window.removeEventListener("resize", refit);
      ro?.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [apply]);

  const reset = useCallback(() => commit(ZERO_OFFSET), [commit]);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !e.isPrimary) return;
    if (e.target instanceof Element && e.target.closest(NO_DRAG)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, from: applied.current };
    if (wrapRef.current) wrapRef.current.dataset.dragging = "true";
  }, []);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      const want = { x: d.from.x + e.clientX - d.startX, y: d.from.y + e.clientY - d.startY };
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => apply(want));
    },
    [apply],
  );

  const endDrag = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      drag.current = null;
      cancelAnimationFrame(frame.current);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      if (wrapRef.current) delete wrapRef.current.dataset.dragging;
      const want =
        e.type === "pointercancel"
          ? d.from
          : { x: d.from.x + e.clientX - d.startX, y: d.from.y + e.clientY - d.startY };
      commit(want);
    },
    [commit],
  );

  const onDoubleClick = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      if (e.target instanceof Element && e.target.closest(NO_DRAG)) return;
      reset();
    },
    [reset],
  );

  const onGripKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "Home") {
        e.preventDefault();
        reset();
        return;
      }
      const n = nudgeFor(e.key, e.shiftKey);
      if (!n) return;
      e.preventDefault();
      commit({ x: applied.current.x + n.x, y: applied.current.y + n.y });
    },
    [commit, reset],
  );

  return {
    wrapRef,
    moved,
    reset,
    /** Spread on the header: the area the panel is dragged by. */
    dragArea: { onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag, onDoubleClick },
    /** Spread on the focusable grip. */
    gripKeys: { onKeyDown: onGripKeyDown },
  };
}
