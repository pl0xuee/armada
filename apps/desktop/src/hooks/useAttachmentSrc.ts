import { useEffect, useMemo, useState } from "react";
import { attachmentSrc } from "@/lib/attachments";
import { cachedPicture, loadPicture } from "@/lib/pictures";
import type { Attachment } from "@/lib/types";

/** The `src` for a picture: built from inline bytes, or loaded from its stored file. */
export function useAttachmentSrc(a: Attachment | undefined): string | undefined {
  return useAttachmentPicture(a).src;
}

/** Like `useAttachmentSrc`, and says when the stored file couldn't be loaded (no src, not loading). */
export function useAttachmentPicture(a: Attachment | undefined): { src?: string; failed: boolean } {
  const path = a && !a.data ? a.path : undefined;
  const inline = useMemo(() => (a?.data ? attachmentSrc(a) : undefined), [a?.data, a?.mimeType]);
  const [loaded, setLoaded] = useState<{ path: string; src?: string }>();
  useEffect(() => {
    if (!path) return;
    let live = true;
    loadPicture(path).then(
      (src) => live && setLoaded({ path, src }),
      () => live && setLoaded({ path }),
    );
    return () => {
      live = false;
    };
  }, [path]);
  if (inline) return { src: inline, failed: false };
  if (!path) return { failed: false };
  if (loaded?.path === path) return { src: loaded.src, failed: !loaded.src };
  return { src: cachedPicture(path), failed: false };
}
