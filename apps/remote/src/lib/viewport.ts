/**
 * Publishes the on-screen keyboard overlap as the CSS variable `--kb` (px).
 * iOS Safari doesn't shrink the layout viewport for the keyboard, so sticky
 * bottom UI (composer, "Latest" button, toasts) would hide behind it; Android
 * with `interactive-widget=resizes-content` resizes, so `--kb` stays 0 there.
 */
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
      document.documentElement.style.setProperty("--kb", `${kb}px`);
    }
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(update);
  };
  vv.addEventListener("resize", schedule, { passive: true });
  vv.addEventListener("scroll", schedule, { passive: true });
  update();
}
