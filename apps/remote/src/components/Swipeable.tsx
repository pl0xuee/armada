import { useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Icon } from "./Icon";

const LOCK_PX = 10;
const COMMIT_RATIO = 0.38;
const FLY_MS = 180;

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Horizontal swipe actions for a card: right = approve, left = deny.
 * Vertical scrolling always wins (`touch-action: pan-y`), the gesture only
 * locks after a clearly horizontal move, nothing fires below the commit
 * threshold, and children marked `data-noswipe` (code, diffs) keep their own
 * horizontal scrolling.
 */
export function Swipeable({
  children,
  onSwipeRight,
  onSwipeLeft,
  rightLabel,
  leftLabel,
  disabled,
}: {
  children: ReactNode;
  onSwipeRight?: () => void;
  onSwipeLeft?: () => void;
  rightLabel: string;
  leftLabel: string;
  disabled?: boolean;
}) {
  const [dx, setDx] = useState(0);
  const [phase, setPhase] = useState<"idle" | "drag" | "settle" | "fly">("idle");
  const root = useRef<HTMLDivElement>(null);
  const g = useRef<{ id: number; x: number; y: number; lock: "h" | "v" | null; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const width = () => root.current?.offsetWidth ?? 320;

  const end = () => {
    const s = g.current;
    g.current = null;
    if (!s || s.lock !== "h") return;
    const w = width();
    const commit = Math.abs(dx) > w * COMMIT_RATIO;
    const action = dx > 0 ? onSwipeRight : onSwipeLeft;
    if (commit && action) {
      if (prefersReducedMotion()) {
        setDx(0);
        setPhase("idle");
        action();
        return;
      }
      setPhase("fly");
      setDx(dx > 0 ? w * 1.1 : -w * 1.1);
      setTimeout(() => {
        action();
        // If the action fails the card stays mounted; bring it back.
        setPhase("settle");
        setDx(0);
      }, FLY_MS);
    } else {
      setPhase("settle");
      setDx(0);
    }
  };

  const progress = Math.min(1, Math.abs(dx) / (width() * COMMIT_RATIO));
  const armed = progress >= 1;
  const right = dx > 0;

  return (
    <div ref={root} className="relative">
      {dx !== 0 && (
        <div
          className={cn(
            "absolute inset-0 flex items-center rounded-2xl px-6",
            right ? "justify-start bg-ok/15 text-ok" : "justify-end bg-err/15 text-err",
          )}
          style={{ opacity: 0.35 + progress * 0.65 }}
          aria-hidden
        >
          <span
            className="flex items-center gap-2 text-[15px] font-semibold"
            style={{ transform: `scale(${armed ? 1.06 : 0.92 + progress * 0.08})`, transition: "transform 120ms" }}
          >
            <Icon name={right ? "check" : "x"} size={22} strokeWidth={2.4} />
            {right ? rightLabel : leftLabel}
          </span>
        </div>
      )}
      <div
        style={{
          transform: dx ? `translate3d(${dx}px,0,0) rotate(${dx / 60}deg)` : undefined,
          transition: phase === "drag" ? "none" : `transform ${FLY_MS}ms var(--ease-out), opacity ${FLY_MS}ms`,
          opacity: phase === "fly" ? 0 : 1,
          touchAction: "pan-y",
        }}
        onTransitionEnd={() => phase === "settle" && setPhase("idle")}
        onPointerDown={(e) => {
          if (disabled || e.button !== 0 || e.pointerType === "mouse") return;
          if ((e.target as HTMLElement).closest("[data-noswipe]")) return;
          g.current = { id: e.pointerId, x: e.clientX, y: e.clientY, lock: null, moved: false };
          suppressClick.current = false;
        }}
        onPointerMove={(e) => {
          const s = g.current;
          if (!s || s.id !== e.pointerId) return;
          const mx = e.clientX - s.x;
          const my = e.clientY - s.y;
          if (!s.lock) {
            if (Math.abs(mx) > LOCK_PX && Math.abs(mx) > Math.abs(my) * 1.3) {
              s.lock = "h";
              suppressClick.current = true;
              setPhase("drag");
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            } else if (Math.abs(my) > LOCK_PX) {
              s.lock = "v";
            }
          }
          if (s.lock !== "h") return;
          const allowed = (mx > 0 && onSwipeRight) || (mx < 0 && onSwipeLeft);
          // Rubber-band when there is no action in that direction.
          setDx(allowed ? mx : mx * 0.15);
        }}
        onPointerUp={end}
        onPointerCancel={() => {
          g.current = null;
          setPhase("settle");
          setDx(0);
        }}
        onClickCapture={(e) => {
          if (suppressClick.current) {
            e.preventDefault();
            e.stopPropagation();
            suppressClick.current = false;
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
