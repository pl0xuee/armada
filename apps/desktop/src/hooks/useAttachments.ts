import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { toast } from "sonner";
import { filesToAttachments, hasFiles, imageFilesFrom, MAX_ATTACHMENTS } from "@/lib/attachments";
import type { Attachment } from "@/lib/types";

/**
 * Pending image attachments for a prompt: paste, drag & drop and a file picker,
 * with the 8 images / 5 MB / images-only limits enforced and reported via toast.
 */
export function useAttachments(initial: Attachment[] = []) {
  const [attachments, setAttachments] = useState<Attachment[]>(initial);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const depth = useRef(0);
  const countRef = useRef(attachments.length);
  countRef.current = attachments.length;

  const add = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const { attachments: added, problems } = await filesToAttachments(files, countRef.current);
    if (added.length) setAttachments((cur) => [...cur, ...added].slice(0, MAX_ATTACHMENTS));
    if (problems.length) {
      toast.warning(problems.length === 1 ? problems[0] : `${problems.length} files weren't attached`, {
        description: problems.length > 1 ? problems.join(" · ") : "Images only, up to 5 MB each, 8 per message.",
      });
    }
  }, []);

  const remove = useCallback((i: number) => setAttachments((cur) => cur.filter((_, j) => j !== i)), []);
  const clear = useCallback(() => setAttachments([]), []);
  const openPicker = useCallback(() => inputRef.current?.click(), []);

  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const files = imageFilesFrom(e.clipboardData).filter((f) => f.type.startsWith("image/"));
      if (files.length) {
        e.preventDefault();
        void add(files);
      }
    },
    [add],
  );

  const dropHandlers = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth.current++;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (hasFiles(e.dataTransfer)) e.preventDefault();
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      void add(imageFilesFrom(e.dataTransfer));
    },
  };

  /** Props for the hidden <input type="file">. */
  const inputProps = {
    ref: inputRef,
    type: "file" as const,
    accept: "image/*",
    multiple: true,
    hidden: true,
    tabIndex: -1,
    "aria-hidden": true,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      void add(Array.from(e.target.files ?? []));
      e.target.value = "";
    },
  };

  return { attachments, setAttachments, add, remove, clear, openPicker, onPaste, dropHandlers, dragging, inputProps };
}
