import { ImagePlus } from "lucide-react";
import { MAX_ATTACHMENTS } from "@/lib/attachments";
import { cn } from "@/lib/utils";
import { Tooltip } from "./ui/tooltip";

export function AttachButton({
  onClick,
  count,
  className,
  iconOnly,
}: {
  onClick: () => void;
  count: number;
  iconOnly?: boolean;
  className?: string;
}) {
  const full = count >= MAX_ATTACHMENTS;
  return (
    <Tooltip content={full ? `${MAX_ATTACHMENTS} images max` : "Attach images (or paste / drop them)"}>
      <button
        type="button"
        onClick={onClick}
        disabled={full}
        aria-label="Attach images"
        className={cn(
          "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-40",
          className,
        )}
      >
        <ImagePlus className="h-3.5 w-3.5" />
        {count > 0 ? <span className="tabular">{count}</span> : !iconOnly && <span>Image</span>}
      </button>
    </Tooltip>
  );
}

/** Covers the drop target while files are dragged over it. */
export function DropOverlay({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-[inherit] border-2 border-dashed border-accent/60 bg-accent/[0.08] text-[12.5px] font-medium text-accent backdrop-blur-[1px]",
        className,
      )}
    >
      <ImagePlus className="h-4 w-4" />
      Drop images to attach
    </div>
  );
}
