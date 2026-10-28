import { X } from "lucide-react";
import { useState } from "react";
import { attachmentSrc } from "@/lib/attachments";
import type { Attachment } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ImageLightbox } from "./ImageLightbox";

/** Thumbnails for pending (removable) or sent attachments; click to enlarge. */
export function AttachmentStrip({
  attachments,
  onRemove,
  size = 56,
  className,
}: {
  attachments: Attachment[];
  onRemove?: (index: number) => void;
  size?: number;
  className?: string;
}) {
  const [open, setOpen] = useState<number | null>(null);
  if (attachments.length === 0) return null;
  return (
    <>
      <ul className={cn("flex flex-wrap gap-2", className)} aria-label="Attached images">
        {attachments.map((a, i) => (
          <li key={`${a.name}-${i}`} className="group relative">
            <button
              type="button"
              onClick={() => setOpen(i)}
              aria-label={`View ${a.name}`}
              className="block overflow-hidden rounded-lg border border-line-strong bg-base transition-transform duration-150 hover:scale-[1.03] active:scale-[0.98]"
              style={{ width: size, height: size }}
            >
              <img src={attachmentSrc(a)} alt={a.name} className="h-full w-full object-cover" draggable={false} />
            </button>
            {onRemove && (
              <button
                type="button"
                onClick={() => onRemove(i)}
                aria-label={`Remove ${a.name}`}
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-line-strong bg-raised text-muted shadow-md transition-colors hover:bg-err hover:text-white"
              >
                <X className="h-3 w-3" strokeWidth={2.5} />
              </button>
            )}
          </li>
        ))}
      </ul>
      <ImageLightbox images={attachments} index={open} onIndexChange={setOpen} />
    </>
  );
}
