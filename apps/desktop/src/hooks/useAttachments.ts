import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent, type SetStateAction } from "react";
import { toast } from "sonner";
import {
  ACCEPTED_IMAGE_LABEL,
  ACCEPTED_IMAGE_TYPES,
  filesToAttachments,
  hasFiles,
  hasText,
  isFileListPaste,
  imageFilesFrom,
  MAX_ATTACHMENTS,
} from "@/lib/attachments";
import { api } from "@/lib/api";
import type { Attachment } from "@/lib/types";

/**
 * Pending image attachments for a prompt: paste, drag & drop and a file picker,
 * with the 8 images / 5 MB / images-only limits enforced and reported via toast.
 */
export function useAttachments(initial: Attachment[] = [], agentId?: string) {
  const [attachments, setRaw] = useState<Attachment[]>(initial);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const depth = useRef(0);
  // Updated synchronously on every change (not from render), so two quick adds can't
  // both see the same free room and silently overflow.
  const liveCount = useRef(initial.length);

  const setAttachments = useCallback((next: SetStateAction<Attachment[]>) => {
    setRaw((cur) => {
      const v = typeof next === "function" ? next(cur) : next;
      liveCount.current = v.length;
      return v;
    });
  }, []);

  const add = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const { attachments: read, problems } = await filesToAttachments(files, liveCount.current);
      // Re-check after the async read: another add may have used the room meanwhile.
      const room = Math.max(0, MAX_ATTACHMENTS - liveCount.current);
      const accepted = read.slice(0, room);
      const dropped = read.length - accepted.length;
      if (dropped > 0) problems.push(`Only ${MAX_ATTACHMENTS} images per message; ${dropped} not attached`);
      if (accepted.length) {
        liveCount.current += accepted.length;
        setAttachments((cur) => [...cur, ...accepted]);
      }
      if (problems.length) {
        toast.warning(problems.length === 1 ? problems[0] : `${problems.length} files weren't attached`, {
          description:
            problems.length > 1
              ? problems.join(" · ")
              : // Format problems already name the accepted formats.
                problems[0].includes(ACCEPTED_IMAGE_LABEL)
                ? `Up to 5 MB each, ${MAX_ATTACHMENTS} per message.`
                : `${ACCEPTED_IMAGE_LABEL}, up to 5 MB each, ${MAX_ATTACHMENTS} per message.`,
        });
      }
    },
    [setAttachments],
  );

  const remove = useCallback((i: number) => setAttachments((cur) => cur.filter((_, j) => j !== i)), [setAttachments]);
  const clear = useCallback(() => setAttachments([]), [setAttachments]);
  const openPicker = useCallback(() => inputRef.current?.click(), []);

  /** Native fallback: WebKitGTK/Wayland often hands the paste event no image file. */
  const addFromClipboard = useCallback(async () => {
    try {
      const { attachments: read, problems } = await api.readClipboardImages(agentId);
      const room = Math.max(0, MAX_ATTACHMENTS - liveCount.current);
      const accepted = read.slice(0, room);
      if (read.length > accepted.length) {
        problems.push(`Only ${MAX_ATTACHMENTS} images per message; ${read.length - accepted.length} not attached`);
      }
      if (accepted.length) {
        liveCount.current += accepted.length;
        setAttachments((cur) => [...cur, ...accepted]);
      }
      if (problems.length) {
        toast.warning(problems.length === 1 ? problems[0] : `${problems.length} images weren't attached`, {
          description: problems.length > 1 ? problems.join(" · ") : `${ACCEPTED_IMAGE_LABEL}, up to 5 MB each.`,
        });
      }
    } catch {
      /* no native clipboard support: the paste simply does nothing */
    }
  }, [setAttachments, agentId]);

  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const files = imageFilesFrom(e.clipboardData).filter((f) => f.type.startsWith("image/"));
      if (files.length === 0) {
        // No image file from the webview. Plain text pastes normally; otherwise (empty, or only
        // file paths from a file manager) ask the OS clipboard directly.
        if (!hasText(e.clipboardData) || isFileListPaste(e.clipboardData)) {
          e.preventDefault();
          void addFromClipboard();
        }
        return;
      }
      // Image + text (e.g. a copied web snippet): keep the text paste, attach the image too.
      if (!hasText(e.clipboardData)) e.preventDefault();
      void add(files);
    },
    [add, addFromClipboard],
  );

  const dropHandlers = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth.current++;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
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
    accept: ACCEPTED_IMAGE_TYPES.join(","),
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
