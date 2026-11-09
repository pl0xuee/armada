import { ImageOff } from "lucide-react";
import type { ImgHTMLAttributes } from "react";
import { useAttachmentPicture } from "@/hooks/useAttachmentSrc";
import type { Attachment } from "@/lib/types";
import { cn } from "@/lib/utils";

/** A picture from an attachment, inline or stored; a placeholder shows while it loads. */
export function AttachmentImg({
  attachment,
  placeholder,
  ...img
}: { attachment: Attachment; placeholder?: string } & Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt">) {
  const { src, failed } = useAttachmentPicture(attachment);
  if (failed) {
    return (
      <span
        role="img"
        aria-label={`${attachment.name} is no longer available`}
        title="Picture no longer available"
        className={cn("flex items-center justify-center bg-raised text-center text-caption text-muted", placeholder ?? "h-full w-full")}
      >
        <ImageOff className="h-4 w-4" aria-hidden />
      </span>
    );
  }
  if (!src) {
    return <span className={cn("skeleton block", placeholder ?? "h-full w-full")} aria-label={`Loading ${attachment.name}`} />;
  }
  return <img src={src} alt={attachment.name} {...img} />;
}
