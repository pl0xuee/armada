/**
 * Position of a floating panel that is anchored bottom-right by CSS and can be dragged away from
 * that spot. The position is stored as an offset (dx, dy) from the anchor, in CSS pixels: negative
 * dx moves left, negative dy moves up. Pure helpers only; the component owns the DOM.
 */

export interface PanelOffset {
  x: number;
  y: number;
}

/** The panel's box when it sits at its default spot (offset 0), in viewport coordinates. */
export interface BaseRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export const PANEL_POS_KEY = "kvistcode.va.pos.v1";
/** Gap kept between the panel and the window edge. */
export const PANEL_MARGIN = 8;
export const NUDGE_STEP = 16;
export const NUDGE_STEP_BIG = 64;

export const ZERO_OFFSET: PanelOffset = { x: 0, y: 0 };

const LIMIT = 100_000;

function clampAxis(value: number, min: number, max: number): number {
  // A panel bigger than the window can't fit: keep its top/left edge visible.
  if (min > max) return Math.round(min);
  return Math.round(Math.min(max, Math.max(min, value)));
}

/** Keeps the whole panel inside the viewport (minus the margin). Result is whole pixels. */
export function clampOffset(
  offset: PanelOffset,
  base: BaseRect,
  viewport: Viewport,
  margin: number = PANEL_MARGIN,
): PanelOffset {
  const minX = margin - base.left;
  const maxX = viewport.width - margin - (base.left + base.width);
  const minY = margin - base.top;
  const maxY = viewport.height - margin - (base.top + base.height);
  return { x: clampAxis(offset.x, minX, maxX), y: clampAxis(offset.y, minY, maxY) };
}

export function isZeroOffset(o: PanelOffset): boolean {
  return o.x === 0 && o.y === 0;
}

export function sameOffset(a: PanelOffset, b: PanelOffset): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Reads a stored position. Anything that is not `{x, y}` with sane numbers means "default". */
export function parseOffset(raw: string | null | undefined): PanelOffset {
  if (!raw) return ZERO_OFFSET;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return ZERO_OFFSET;
    const { x, y } = v as { x?: unknown; y?: unknown };
    if (typeof x !== "number" || typeof y !== "number") return ZERO_OFFSET;
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > LIMIT || Math.abs(y) > LIMIT) return ZERO_OFFSET;
    return { x: Math.round(x), y: Math.round(y) };
  } catch {
    return ZERO_OFFSET;
  }
}

/** The stored form; the default position is stored as nothing at all (null). */
export function serializeOffset(o: PanelOffset): string | null {
  if (isZeroOffset(o)) return null;
  return JSON.stringify({ x: Math.round(o.x), y: Math.round(o.y) });
}

export function offsetTransform(o: PanelOffset): string {
  return `translate3d(${o.x}px, ${o.y}px, 0)`;
}

/** An arrow key's nudge, or null for any other key. Shift moves a bigger step. */
export function nudgeFor(key: string, shift: boolean): PanelOffset | null {
  const step = shift ? NUDGE_STEP_BIG : NUDGE_STEP;
  switch (key) {
    case "ArrowLeft":
      return { x: -step, y: 0 };
    case "ArrowRight":
      return { x: step, y: 0 };
    case "ArrowUp":
      return { x: 0, y: -step };
    case "ArrowDown":
      return { x: 0, y: step };
    default:
      return null;
  }
}

export function loadOffset(): PanelOffset {
  try {
    return parseOffset(localStorage.getItem(PANEL_POS_KEY));
  } catch {
    return ZERO_OFFSET;
  }
}

export function saveOffset(o: PanelOffset): void {
  try {
    const s = serializeOffset(o);
    if (s === null) localStorage.removeItem(PANEL_POS_KEY);
    else localStorage.setItem(PANEL_POS_KEY, s);
  } catch {
    // Storage may be unavailable (private mode, quota); the position just won't persist.
  }
}
