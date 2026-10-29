import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { useOverlay } from "@/lib/overlay";
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
  const dragStart = useRef<number | null>(null);
  const titleId = useId();

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

  // Back closes, background inert, focus trapped (while open, not while animating out).
  useOverlay(open, onClose, panel);
  useEffect(() => {
    if (!mounted) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
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
          "absolute inset-x-0 mx-auto flex w-full max-w-[560px] flex-col rounded-t-[22px] border border-b-0 border-line-strong bg-panel edge-strong outline-none",
          !closing && drag === 0 && "animate-sheet",
        )}
        style={{
          // Above the iOS keyboard (which doesn't resize the page), so fields and the
          // buttons under them stay visible while typing.
          bottom: "var(--kb, 0px)",
          maxHeight: "calc(88dvh - var(--kb, 0px))",
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
        <div className="min-h-0 overflow-y-auto overscroll-contain px-5 pt-1 pb-[max(20px,calc(var(--safe-bottom-kb)+12px))]">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
