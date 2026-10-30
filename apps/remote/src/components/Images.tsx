import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { useOverlay } from "@/lib/overlay";
import type { Attachment } from "@/lib/types";
import { Icon } from "./Icon";

/** Raster types only: SVG can carry script and isn't needed for screenshots. */
const SAFE_MIME = /^image\/(png|jpeg|gif|webp|avif)$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Memoised per attachment object: validating/concatenating MBs of base64 on every render made typing slow. */
const srcCache = new WeakMap<Attachment, string | null>();

/** `data:` URL for an attachment, or null if it isn't a safe, well-formed image. */
export function imageSrc(a: Attachment): string | null {
  if (!a || typeof a !== "object") return null;
  const hit = srcCache.get(a);
  if (hit !== undefined) return hit;
  let src: string | null = null;
  if (typeof a.data === "string" && SAFE_MIME.test(a.mimeType)) {
    const data = /\s/.test(a.data) ? a.data.replace(/\s+/g, "") : a.data;
    if (data && BASE64.test(data)) src = `data:${a.mimeType};base64,${data}`;
  }
  srcCache.set(a, src);
  return src;
}

const MAX_THUMBS = 4;
const MAX_LARGE = 6;

/**
 * Thumbnail strip; tapping one opens the viewer. `large` shows each picture at its own aspect
 * (up to 18rem tall), for pictures that are the content of a reply rather than an attachment.
 */
export function ImageStrip({ images, className, large = false }: { images: Attachment[]; className?: string; large?: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  const valid = images.map((a) => ({ a, src: imageSrc(a) })).filter((x): x is { a: Attachment; src: string } => !!x.src);
  if (!valid.length) return null;
  const shown = valid.slice(0, large ? MAX_LARGE : MAX_THUMBS);
  const extra = valid.length - shown.length;
  return (
    <>
      <div className={cn("flex flex-wrap gap-2", className)} data-noswipe>
        {shown.map(({ a, src }, i) => (
          <button
            key={i}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(i);
            }}
            aria-label={`View image ${a.name || i + 1}`}
            className={cn(
              "press relative overflow-hidden rounded-xl border border-line-strong bg-code",
              large ? "max-w-full" : "h-24 w-[132px] max-w-[calc(50%-4px)]",
            )}
          >
            <img
              src={src}
              alt={a.name || "Screenshot"}
              loading="lazy"
              decoding="async"
              className={large ? "block max-h-72 w-auto max-w-full object-contain" : "h-full w-full object-cover object-top"}
            />
            {extra > 0 && i === shown.length - 1 && (
              <span className="absolute inset-0 flex items-center justify-center bg-black/55 text-[15px] font-semibold text-white">+{extra}</span>
            )}
          </button>
        ))}
      </div>
      {open !== null && <Lightbox images={valid} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </>
  );
}

function Lightbox({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: { a: Attachment; src: string }[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const touch = useRef<number | null>(null);
  const count = images.length;
  const cur = images[Math.min(index, count - 1)];
  const go = (d: number) => onIndex((index + d + count) % count);

  useOverlay(true, onClose, root);
  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={`Image ${index + 1} of ${count}`}
      tabIndex={-1}
      className="animate-fade fixed inset-0 z-[70] flex flex-col bg-black/95 outline-none"
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" && count > 1) go(1);
        else if (e.key === "ArrowLeft" && count > 1) go(-1);
      }}
    >
      <div className="flex shrink-0 items-center gap-2 pt-[var(--safe-top)] pr-[max(4px,var(--safe-right))] pl-[max(16px,var(--safe-left))]">
        <span className="min-w-0 flex-1 truncate text-[13.5px] text-white/80">
          {cur.a.name}
          {count > 1 && <span className="ml-2 text-white/50 tabular">{`${index + 1} / ${count}`}</span>}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="press inline-flex h-12 w-12 items-center justify-center rounded-xl text-white/85 active:bg-white/10"
        >
          <Icon name="x" size={22} />
        </button>
      </div>
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-[max(12px,var(--safe-bottom))]"
        onClick={(e) => e.target === e.currentTarget && onClose()}
        style={{ touchAction: "pan-x pan-y pinch-zoom" }}
        onTouchStart={(e) => (touch.current = e.touches.length === 1 ? (e.touches[0]?.clientX ?? null) : null)}
        onTouchEnd={(e) => {
          const start = touch.current;
          touch.current = null;
          const end = e.changedTouches[0]?.clientX;
          // Swipe between images only at normal zoom (pinch-zoom pans instead).
          const zoomed = (window.visualViewport?.scale ?? 1) > 1.05;
          if (start === null || end === undefined || count < 2 || zoomed || e.touches.length) return;
          if (Math.abs(end - start) > 50) go(end < start ? 1 : -1);
        }}
      >
        <img src={cur.src} alt={cur.a.name || "Screenshot"} className="max-h-full max-w-full rounded-lg object-contain select-none" />
        {count > 1 && (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              aria-label="Previous image"
              className="press absolute top-1/2 left-2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white"
            >
              <Icon name="chevronLeft" size={22} />
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              aria-label="Next image"
              className="press absolute top-1/2 right-2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white"
            >
              <Icon name="chevronRight" size={22} />
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
