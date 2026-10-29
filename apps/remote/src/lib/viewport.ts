/**
 * Publishes the on-screen keyboard overlap as the CSS variable `--kb` (px).
 * iOS Safari doesn't shrink the layout viewport for the keyboard, so sticky
 * bottom UI (composer, "Latest" button, toasts) would hide behind it; Android
 * with `interactive-widget=resizes-content` resizes, so `--kb` stays 0 there.
 */
/** Smaller overlaps are browser chrome (toolbars collapsing), not a keyboard. */
const KEYBOARD_MIN_PX = 80;

export function trackKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  let raf = 0;
  let last = -1;
  const update = () => {
    raf = 0;
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    if (kb !== last) {
      last = kb;
      const root = document.documentElement.style;
      root.setProperty("--kb", `${kb}px`);
      // iOS keeps reporting the home-indicator inset with the keyboard up; padding
      // for it then leaves an empty band above the keyboard.
      if (kb > KEYBOARD_MIN_PX) root.setProperty("--safe-bottom-kb", "0px");
      else root.removeProperty("--safe-bottom-kb");
    }
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(update);
  };
  vv.addEventListener("resize", schedule, { passive: true });
  vv.addEventListener("scroll", schedule, { passive: true });
  update();
}
