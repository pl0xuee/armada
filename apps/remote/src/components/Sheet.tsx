import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { Icon } from "./Icon";

const CLOSE_MS = 180;

/**
 * Bottom sheet dialog: focus is moved in and restored, Escape and the
 * backdrop close it, and it can be dragged down to dismiss.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const [drag, setDrag] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  const dragStart = useRef<number | null>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      setDrag(0);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const t = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, CLOSE_MS);
    return () => clearTimeout(t);
  }, [open, mounted]);

  useEffect(() => {
    if (!mounted) return;
    restore.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const raf = requestAnimationFrame(() => panel.current?.focus({ preventScroll: true }));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === "Tab" && panel.current) {
        // Keep focus inside the dialog.
        const focusable = panel.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], textarea, input, [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      restore.current?.focus?.({ preventScroll: true });
    };
  }, [mounted]);

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50" role="presentation">
      <div
        className={cn("absolute inset-0 bg-black/60 transition-opacity duration-150", closing ? "opacity-0" : "animate-fade")}
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          "absolute inset-x-0 bottom-0 mx-auto flex max-h-[88dvh] w-full max-w-[560px] flex-col rounded-t-[22px] border border-b-0 border-line-strong bg-panel edge-strong outline-none",
          !closing && drag === 0 && "animate-sheet",
        )}
        style={{
          transform: closing ? "translateY(100%)" : drag ? `translateY(${drag}px)` : undefined,
          transition: closing ? `transform ${CLOSE_MS}ms var(--ease-out)` : dragStart.current === null ? "transform 160ms var(--ease-out)" : "none",
        }}
      >
        <div
          className="flex shrink-0 touch-none flex-col items-center px-5 pt-2.5 pb-2"
          onPointerDown={(e) => {
            dragStart.current = e.clientY;
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (dragStart.current === null) return;
            setDrag(Math.max(0, e.clientY - dragStart.current));
          }}
          onPointerUp={() => {
            const d = drag;
            dragStart.current = null;
            if (d > 90) onClose();
            else setDrag(0);
          }}
          onPointerCancel={() => {
            dragStart.current = null;
            setDrag(0);
          }}
        >
          <span className="h-[5px] w-10 rounded-full bg-line-strong" aria-hidden />
          <div className="mt-3 flex w-full items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-[17px] leading-snug font-semibold text-fg">
                {title}
              </h2>
              {description && <div className="mt-0.5 text-[13.5px] text-muted">{description}</div>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="press -mt-1.5 -mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-steel active:bg-raised"
            >
              <Icon name="x" size={20} />
            </button>
          </div>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain px-5 pt-1 pb-[max(20px,calc(var(--safe-bottom)+12px))]">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
