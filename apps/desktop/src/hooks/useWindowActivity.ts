import { useEffect } from "react";

/**
 * Marks <html data-window="blurred"> while the window is hidden or unfocused; the stylesheet pauses every
 * CSS animation under it, so a background window doesn't keep compositing spinners and pulses.
 */
export function useWindowActivity() {
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => {
      // hasFocus() stays true while focus is inside a preview iframe, which also blurs the window.
      if (document.hidden || !document.hasFocus()) root.dataset.window = "blurred";
      else delete root.dataset.window;
    };
    sync();
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
      delete root.dataset.window;
    };
  }, []);
}
