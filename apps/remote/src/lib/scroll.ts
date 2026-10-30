/**
 * The timeline follows new content while the reader is at the bottom. When the
 * reader expands something themselves, the resulting growth must not yank the
 * page, so toggles call `noteUserLayoutChange()` first.
 */
let suppressUntil = 0;

export function noteUserLayoutChange() {
  suppressUntil = performance.now() + 600;
}

export function isUserLayoutChange() {
  return performance.now() < suppressUntil;
}

/**
 * Scroll corrections the timeline makes on its own (rows above the viewport changing height, older
 * messages prepended) keep what the reader sees in place, so they must not count as the reader
 * scrolling away: the resulting scroll events are ignored for a moment (`isProgrammaticScroll`).
 */
let programmaticUntil = 0;

export function scrollByProgrammatic(dy: number) {
  programmaticUntil = performance.now() + 200;
  window.scrollBy(0, dy);
}

export function isProgrammaticScroll() {
  return performance.now() < programmaticUntil;
}
