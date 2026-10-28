import * as D from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { attachmentSrc } from "@/lib/attachments";
import type { Attachment } from "@/lib/types";

/** Full-size image viewer with arrow-key navigation. */
export function ImageLightbox({
  images,
  index,
  onIndexChange,
}: {
  images: Attachment[];
  index: number | null;
  onIndexChange: (i: number | null) => void;
}) {
  const current = index !== null ? images[index] : undefined;
  const many = images.length > 1;
  const step = (d: number) => index !== null && onIndexChange((index + d + images.length) % images.length);

  return (
    <D.Root open={!!current} onOpenChange={(o) => !o && onIndexChange(null)}>
      <D.Portal>
        <D.Overlay className="anim-fade fixed inset-0 z-[90] bg-black/80 backdrop-blur-sm" />
        <D.Content
          aria-describedby={undefined}
          onKeyDown={(e) => {
            if (!many) return;
            if (e.key === "ArrowRight") step(1);
            if (e.key === "ArrowLeft") step(-1);
          }}
          className="anim-fade fixed inset-0 z-[90] flex flex-col items-center justify-center p-10 focus:outline-none max-sm:p-4"
          onClick={(e) => e.target === e.currentTarget && onIndexChange(null)}
        >
          <D.Title className="sr-only">{current?.name ?? "Image"}</D.Title>
          {current && (
            <img
              src={attachmentSrc(current)}
              alt={current.name}
              className="max-h-[calc(100vh-120px)] max-w-full rounded-xl border border-white/10 object-contain shadow-2xl"
            />
          )}
          <div className="mt-3 flex items-center gap-3 text-[12px] text-white/70">
            <span className="max-w-[60vw] truncate">{current?.name}</span>
            {many && index !== null && (
              <span className="tabular">
                {index + 1} / {images.length}
              </span>
            )}
          </div>
          {many && (
            <>
              <button
                type="button"
                aria-label="Previous image"
                onClick={() => step(-1)}
                className="absolute left-4 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button
                type="button"
                aria-label="Next image"
                onClick={() => step(1)}
                className="absolute right-4 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            </>
          )}
          <D.Close
            aria-label="Close"
            className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
          >
            <X className="h-4 w-4" />
          </D.Close>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
