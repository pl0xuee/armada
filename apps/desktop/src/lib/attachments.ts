import type { Attachment } from "./types";

export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export function attachmentSrc(a: Attachment): string {
  return `data:${a.mimeType};base64,${a.data}`;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error(`Couldn't read ${file.name}`));
    r.onload = () => {
      const url = String(r.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    r.readAsDataURL(file);
  });
}

/**
 * Validate and read image files. Returns the attachments that fit the limits
 * (images only, 5 MB each, 8 total) and human-readable reasons for the rest.
 */
export async function filesToAttachments(
  files: Iterable<File>,
  existing: number,
): Promise<{ attachments: Attachment[]; problems: string[] }> {
  const attachments: Attachment[] = [];
  const problems: string[] = [];
  let room = MAX_ATTACHMENTS - existing;
  for (const file of files) {
    if (!file.type.startsWith("image/")) {
      problems.push(`${file.name || "File"} isn't an image`);
      continue;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      problems.push(`${file.name || "Image"} is larger than 5 MB`);
      continue;
    }
    if (room <= 0) {
      problems.push(`Only ${MAX_ATTACHMENTS} images per message`);
      break;
    }
    try {
      const data = await readAsBase64(file);
      const ext = file.type.split("/")[1] ?? "png";
      attachments.push({ name: file.name || `pasted-image.${ext}`, mimeType: file.type, data });
      room--;
    } catch {
      problems.push(`Couldn't read ${file.name || "image"}`);
    }
  }
  return { attachments, problems };
}

/** Image files from a paste or drop event. */
export function imageFilesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === "file") {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  if (out.length === 0) out.push(...Array.from(dt.files ?? []));
  return out;
}

export function hasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types ?? []).includes("Files");
}
