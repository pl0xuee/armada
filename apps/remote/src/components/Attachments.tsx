import { useRef, useState } from "react";
import { attachError, MAX_ATTACHMENTS, prepareImage } from "@/lib/attachments";
import { cn } from "@/lib/cn";
import { toastError } from "@/lib/controller";
import type { Attachment } from "@/lib/types";
import { Icon, Spinner } from "./Icon";
import { imageSrc } from "./Images";

/**
 * Photo picking for prompts: the OS sheet offers camera or library (a second
 * input opens the camera directly). Images are downscaled before they're
 * added, and handed to `add` as a list for a functional merge, so photos
 * picked while another update is in flight are never dropped.
 */
export function usePhotoPicker(current: Attachment[], add: (list: Attachment[]) => void) {
  const input = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(current);
  latest.current = current;
  const full = current.length >= MAX_ATTACHMENTS;

  const onFiles = async (el: HTMLInputElement) => {
    const files = el.files;
    if (!files?.length) return;
    setBusy(true);
    const picked: Attachment[] = [];
    try {
      for (const file of Array.from(files)) {
        const att = await prepareImage(file);
        const err = attachError([...latest.current, ...picked], att);
        if (err) {
          toastError("Couldn't attach that photo", new Error(err));
          break;
        }
        picked.push(att);
      }
    } catch (e) {
      toastError("Couldn't attach that photo", e);
    } finally {
      setBusy(false);
      el.value = "";
      if (picked.length) add(picked);
    }
  };

  const element = (
    <>
      <input ref={input} type="file" accept="image/*" multiple className="hidden" tabIndex={-1} aria-hidden onChange={(e) => void onFiles(e.currentTarget)} />
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => void onFiles(e.currentTarget)}
      />
    </>
  );
  return { element, open: () => input.current?.click(), openCamera: () => camera.current?.click(), busy, full };
}

export function AttachButton({ picker, className }: { picker: ReturnType<typeof usePhotoPicker>; className?: string }) {
  return (
    <button
      type="button"
      onClick={picker.open}
      disabled={picker.busy || picker.full}
      aria-label={picker.full ? `Up to ${MAX_ATTACHMENTS} photos` : "Attach photos"}
      className={cn(
        "press inline-flex h-12 w-11 shrink-0 items-center justify-center rounded-full text-steel active:bg-raised active:text-fg disabled:opacity-40",
        className,
      )}
    >
      {picker.busy ? <Spinner size={18} /> : <Icon name="image" size={22} />}
    </button>
  );
}

/** Thumbnails of photos about to be sent, each removable. */
export function AttachmentTray({ attachments, onRemove, className }: { attachments: Attachment[]; onRemove: (i: number) => void; className?: string }) {
  if (!attachments.length) return null;
  return (
    <ul className={cn("flex gap-2 overflow-x-auto pb-1", className)} aria-label="Attached photos">
      {attachments.map((a, i) => {
        const src = imageSrc(a);
        return (
          <li key={`${a.name}-${i}`} className="relative h-16 w-16 shrink-0">
            {src ? (
              <img src={src} alt={a.name} className="h-full w-full rounded-xl border border-line-strong object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center rounded-xl border border-line-strong bg-card text-steel">
                <Icon name="image" size={20} />
              </span>
            )}
            <button
              type="button"
              onClick={() => onRemove(i)}
              aria-label={`Remove ${a.name}`}
              className="press hit absolute -top-2 -right-2 inline-flex h-7 w-7 items-center justify-center rounded-full border border-line-strong bg-raised text-fg shadow"
            >
              <Icon name="x" size={14} strokeWidth={2.4} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
