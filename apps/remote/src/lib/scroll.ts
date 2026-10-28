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
