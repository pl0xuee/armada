/**
 * Behaviour shared by sheets and the image viewer:
 * - Back (Android button / gesture, browser back) closes the overlay instead of
 *   leaving the screen: a history entry is pushed while it's open and popped
 *   when it closes by other means.
 * - The app behind is `inert` (no focus, no screen-reader browsing).
 * - Focus is trapped inside and restored afterwards.
 */
import { useEffect, useRef, type RefObject } from "react";

let openCount = 0;
let seq = 0;
/**
 * An overlay closed by the UI leaves its history entry behind; we step back
 * over it on the next tick. If another overlay opens in the meantime (e.g. the
 * details sheet hands over to a picker), it adopts that entry instead, because
 * a pushState racing a pending back() could pop the new overlay immediately.
 */
let orphan: { token: number; timer: ReturnType<typeof setTimeout> } | null = null;

const currentOverlay = () => (history.state as { overlay?: number } | null)?.overlay;

function setBackgroundInert(inert: boolean) {
  const root = document.getElementById("root");
  if (!root) return;
  if (inert) root.setAttribute("inert", "");
  else root.removeAttribute("inert");
}

export function useOverlay(open: boolean, onClose: () => void, panel: RefObject<HTMLElement | null>) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const token = ++seq;
    const restore = document.activeElement as HTMLElement | null;
    if (orphan && currentOverlay() === orphan.token) {
      clearTimeout(orphan.timer);
      history.replaceState({ ...(history.state as object | null), overlay: token }, "", location.href);
    } else {
      history.pushState({ ...(history.state as object | null), overlay: token }, "", location.href);
    }
    orphan = null;
    let popped = false;
    const onPop = () => {
      if (currentOverlay() !== token) {
        popped = true;
        onCloseRef.current();
      }
    };
    window.addEventListener("popstate", onPop);

    openCount++;
    setBackgroundInert(true);

    const onKey = (e: KeyboardEvent) => {
      const el = panel.current;
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === "Tab" && el) {
        const focusable = el.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], textarea, input:not([type="hidden"]), select, [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    const raf = requestAnimationFrame(() => panel.current?.focus({ preventScroll: true }));

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", onPop);
      openCount = Math.max(0, openCount - 1);
      if (!openCount) setBackgroundInert(false);
      // Closed by the UI: drop our history entry (if it's still the current one),
      // unless another overlay adopts it first.
      if (!popped && currentOverlay() === token) {
        const timer = setTimeout(() => {
          if (orphan?.token === token && currentOverlay() === token) history.back();
          if (orphan?.token === token) orphan = null;
        }, 0);
        orphan = { token, timer };
      }
      restore?.focus?.({ preventScroll: true });
    };
  }, [open, panel]);
}
