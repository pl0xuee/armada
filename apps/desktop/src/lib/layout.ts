// Shared responsive breakpoints (viewport widths, px).
/** At or above this width the agent list docks beside the conversation; below it becomes a drawer. */
export const LIST_DOCK_QUERY = "(min-width: 960px)";
/** Inspector docks beside the conversation at or above this width; below it's an overlay. */
export const INSPECTOR_DOCK_QUERY = "(min-width: 1180px)";
/** Compact title bar below this width. */
export const COMPACT_TITLEBAR_QUERY = "(max-width: 759px)";

/** Preview pane (right of the conversation): least width each side keeps. */
export const PREVIEW_MIN_WIDTH = 320;
export const CHAT_MIN_WIDTH = 360;
export const PREVIEW_DEFAULT_WIDTH = 560;
/** The docked inspector only stays while the conversation keeps at least this much beside the preview. */
export const CHAT_COMFORT_WIDTH = 460;
/** Docked inspector column width (matches the Inspector's own width). */
export const INSPECTOR_WIDTH = 272;

export interface PreviewLayout {
  /** "split": chat left, preview right. "full": the preview covers the whole agent view. */
  mode: "split" | "full";
  /** Whether a docked inspector keeps its column. */
  inspector: boolean;
  /** Preview width in px (split mode). */
  width: number;
}

/** Clamps a wanted preview width into [PREVIEW_MIN_WIDTH, room - CHAT_MIN_WIDTH] (min wins if room is short). */
export function clampPreviewWidth(want: number, room: number): number {
  const max = Math.max(PREVIEW_MIN_WIDTH, room - CHAT_MIN_WIDTH);
  return Math.max(PREVIEW_MIN_WIDTH, Math.min(max, Math.round(want)));
}

/**
 * Lays out the agent view when the preview is open. `container` is the agent view's width,
 * `inspectorDocked` whether the inspector would take a column. The inspector is dropped first for
 * room (or when it would squeeze the conversation below a comfortable width); if chat + preview still don't fit, the preview takes the whole view.
 */
export function previewLayout(container: number, inspectorDocked: boolean, want: number): PreviewLayout {
  const need = CHAT_MIN_WIDTH + PREVIEW_MIN_WIDTH;
  const withInspector = container - INSPECTOR_WIDTH;
  const inspector =
    inspectorDocked &&
    withInspector >= need &&
    withInspector - clampPreviewWidth(want, withInspector) >= CHAT_COMFORT_WIDTH;
  const room = container - (inspector ? INSPECTOR_WIDTH : 0);
  if (container > 0 && room < need) return { mode: "full", inspector: false, width: container };
  return { mode: "split", inspector, width: clampPreviewWidth(want, room) };
}
