import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/** What is being dragged in the project list: a project (by folder) or a section (by id). */
export interface DragItem {
  kind: "project" | "section";
  id: string;
  name: string;
}

/**
 * Where a drop would land. A project goes to a group (`section`, null = none) at `index` among that group's other
 * projects; a section to `index` among the other sections. `line` is the insertion line's top in the list's scrolled
 * content (null when a header or an empty group lights up instead, named by `highlight`).
 */
export interface DropTarget {
  section: string | null;
  index: number;
  line: number | null;
  highlight: string | null;
}

export interface DragState {
  item: DragItem;
  target: DropTarget | null;
  /** Where the pointer was when the drag started, for the floating chip's first frame. */
  x: number;
  y: number;
}

/**
 * The list marks what can be dropped on with data attributes (inside `root`, the scrolling list):
 * - `data-drop-group="<section id>"` ("" = no section) wraps a group's `data-project-block="<path>"` children;
 * - `data-section-header="<id>"` (with `data-collapsed`) is a section's header, `data-section-block="<id>"` all of it.
 */
export function findTarget(root: HTMLElement, item: DragItem, y: number): DropTarget | null {
  const top = root.getBoundingClientRect().top - root.scrollTop;
  const rects = <T extends Element>(els: Iterable<T>) => [...els].map((el) => ({ el, r: el.getBoundingClientRect() }));
  // Between two blocks, halfway through the gap; after the last one, just below it.
  const lineAt = (blocks: { r: DOMRect }[], index: number) =>
    index < blocks.length
      ? blocks[index].r.top - top - (index > 0 ? (blocks[index].r.top - blocks[index - 1].r.bottom) / 2 : 4) - 1
      : blocks[blocks.length - 1].r.bottom - top + 3;
  const indexAt = (blocks: { r: DOMRect }[]) => blocks.filter((b) => y > b.r.top + b.r.height / 2).length;

  if (item.kind === "section") {
    const blocks = rects(root.querySelectorAll<HTMLElement>("[data-section-block]")).filter(
      (b) => b.el.dataset.sectionBlock !== item.id,
    );
    if (blocks.length === 0) return null;
    const index = indexAt(blocks);
    return { section: null, index, line: lineAt(blocks, index), highlight: null };
  }

  // On a section's header: into that section (first when it is open, last when it is folded).
  for (const { el, r } of rects(root.querySelectorAll<HTMLElement>("[data-section-header]"))) {
    if (y < r.top || y > r.bottom) continue;
    const id = el.dataset.sectionHeader!;
    const folded = el.dataset.collapsed === "true";
    return { section: id, index: folded ? Number.MAX_SAFE_INTEGER : 0, line: null, highlight: `header:${id}` };
  }
  // Otherwise the group under the pointer, or the nearest one.
  let best: { el: HTMLElement; r: DOMRect; d: number } | null = null;
  for (const { el, r } of rects(root.querySelectorAll<HTMLElement>("[data-drop-group]"))) {
    if (r.height === 0) continue;
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (!best || d < best.d) best = { el, r, d };
  }
  if (!best) return null;
  const key = best.el.dataset.dropGroup ?? "";
  const section = key === "" ? null : key;
  const blocks = rects(best.el.querySelectorAll<HTMLElement>(":scope > [data-project-block]")).filter(
    (b) => b.el.dataset.projectBlock !== item.id,
  );
  if (blocks.length === 0) return { section, index: 0, line: null, highlight: `group:${key}` };
  const index = indexAt(blocks);
  return { section, index, line: lineAt(blocks, index), highlight: null };
}

const same = (a: DropTarget | null, b: DropTarget | null) =>
  a === b ||
  (!!a && !!b && a.section === b.section && a.index === b.index && a.line === b.line && a.highlight === b.highlight);

/**
 * Pointer dragging for the project list (HTML drag and drop is unreliable in the desktop webviews). A press that moves
 * 4px starts it; near the list's top or bottom edge the list scrolls; Esc cancels; the click that ends a drag is
 * swallowed so the header doesn't also fold. `chipRef` is the floating label, moved without re-rendering.
 */
export function useProjectDrag(
  rootRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  onDrop: (item: DragItem, target: DropTarget) => void,
) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const chipRef = useRef<HTMLDivElement>(null);
  const onDropRef = useRef(onDrop);
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    onDropRef.current = onDrop;
  });
  useEffect(() => () => cancelRef.current?.(), []);

  const handle = (item: DragItem) => (e: ReactPointerEvent) => {
    if (!enabled || e.button !== 0 || e.pointerType === "touch" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey)
      return;
    cancelRef.current?.();
    const sx = e.clientX;
    const sy = e.clientY;
    let x = sx;
    let y = sy;
    let started = false;
    let target: DropTarget | null = null;
    let raf = 0;
    const place = () => {
      const root = rootRef.current;
      const next = root ? findTarget(root, item, y) : null;
      if (same(next, target)) return;
      target = next;
      setDrag((d) => (d ? { ...d, target: next } : d));
    };
    // Scrolls while the pointer rests near an edge, faster the closer it is.
    const tick = () => {
      const root = rootRef.current;
      if (root) {
        const r = root.getBoundingClientRect();
        const edge = 40;
        const dy = y < r.top + edge ? -(r.top + edge - y) : y > r.bottom - edge ? y - (r.bottom - edge) : 0;
        if (dy !== 0) {
          const before = root.scrollTop;
          root.scrollTop += Math.max(-16, Math.min(16, Math.round(dy / 3)));
          if (root.scrollTop !== before) place();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    const move = (ev: PointerEvent) => {
      x = ev.clientX;
      y = ev.clientY;
      if (!started) {
        if (Math.hypot(x - sx, y - sy) < 4) return;
        started = true;
        document.documentElement.dataset.dragging = item.kind;
        setDrag({ item, target: null, x, y });
        raf = requestAnimationFrame(tick);
      }
      if (chipRef.current) chipRef.current.style.transform = `translate3d(${x + 14}px, ${y + 10}px, 0)`;
      place();
    };
    const finish = (drop: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", cancel);
      cancelAnimationFrame(raf);
      cancelRef.current = null;
      if (!started) return;
      delete document.documentElement.dataset.dragging;
      const swallow = (ev: MouseEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      setDrag(null);
      if (drop && target) onDropRef.current(item, target);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !started) return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", cancel);
    cancelRef.current = cancel;
  };

  return { drag, chipRef, handle };
}
