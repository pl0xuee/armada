/**
 * Photo attachments from the phone: limits, sizing and encoding. The server
 * accepts at most 4 images per prompt and a 24 MB body; phone photos are
 * downscaled before upload so they fit and send quickly.
 */
import type { Attachment } from "./types";

export const MAX_ATTACHMENTS = 4;
export const MAX_DIMENSION = 1600;
export const JPEG_QUALITY = 0.8;
/** Base64 budget for all attachments (leaves headroom under the 24 MB body cap). */
export const MAX_TOTAL_BASE64 = 20 * 1024 * 1024;
/** Small PNG/GIF/WebP screenshots are sent as-is (re-encoding would blur text). */
const KEEP_ORIGINAL_BYTES = 1_500_000;

export function fitWithin(width: number, height: number, max = MAX_DIMENSION): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export interface EncodePlan {
  reencode: boolean;
  width: number;
  height: number;
  mimeType: string;
}

/**
 * Decide whether an image can be sent as-is or must be re-encoded as a smaller
 * JPEG. JPEGs are always re-encoded: that strips EXIF (GPS location, device)
 * and bakes in the orientation.
 */
export function planEncode(mimeType: string, bytes: number, width: number, height: number): EncodePlan {
  const fit = fitWithin(width, height);
  const keepable = /^image\/(png|gif|webp)$/.test(mimeType);
  const small = bytes <= KEEP_ORIGINAL_BYTES && fit.width === width && fit.height === height;
  if (keepable && small) return { reencode: false, width, height, mimeType };
  return { reencode: true, ...fit, mimeType: "image/jpeg" };
}

/** Split a `data:` URL into the API's `{ mimeType, data }` (no prefix). */
export function fromDataUrl(url: string): { mimeType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return m ? { mimeType: m[1], data: m[2] } : null;
}

export function base64Size(atts: Pick<Attachment, "data">[]): number {
  return atts.reduce((n, a) => n + a.data.length, 0);
}

/** Why another image can't be added, or null if it can. */
export function attachError(current: Pick<Attachment, "data">[], next: Pick<Attachment, "data">): string | null {
  if (current.length >= MAX_ATTACHMENTS) return `You can attach up to ${MAX_ATTACHMENTS} images.`;
  if (base64Size(current) + next.data.length > MAX_TOTAL_BASE64) return "These images are too large to send together.";
  return null;
}

/** Add restored photos after the current ones, within the limits. */
export function mergeAttachments(current: Attachment[], incoming: Attachment[]): { list: Attachment[]; dropped: number } {
  const list = current.slice();
  let dropped = 0;
  for (const a of incoming) {
    if (attachError(list, a)) dropped++;
    else list.push(a);
  }
  return { list, dropped };
}

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
};

/** The file's type, or one inferred from its extension (some pickers leave `type` empty). */
export function inferMime(name: string, type: string): string {
  if (type) return type;
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (ext && EXT_MIME[ext]) || "";
}

function extensionFor(mimeType: string) {
  return mimeType === "image/jpeg" ? "jpg" : (mimeType.split("/")[1] ?? "img");
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(blob);
  });
}

/** Natural (orientation-corrected) size without decoding the whole image. */
function probe(file: File): Promise<{ width: number; height: number; img: HTMLImageElement; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight, img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode failed"));
    };
    img.src = url;
  });
}

/** Read a picked photo, downscaling/re-encoding it when needed. */
export async function prepareImage(file: File): Promise<Attachment> {
  const mime = inferMime(file.name, file.type);
  if (!mime.startsWith("image/")) throw new Error("Only images can be attached.");
  const label = file.name || "that image";
  const p = await probe(file).catch(() => {
    throw new Error(`Couldn't read ${label}. Try a JPEG or PNG.`);
  });
  try {
    const plan = planEncode(mime, file.size, p.width, p.height);
    const baseName = (file.name || "photo").replace(/\.[^.]+$/, "");
    if (!plan.reencode) {
      const parsed = fromDataUrl(await readAsDataUrl(file));
      if (!parsed) throw new Error(`Couldn't read ${label}.`);
      return { name: file.name || `${baseName}.${extensionFor(parsed.mimeType)}`, mimeType: parsed.mimeType, data: parsed.data };
    }
    // Decode straight to the target size where supported (no full-size bitmap
    // in memory for a 12 MP photo); otherwise scale the probed <img>.
    let source: CanvasImageSource = p.img;
    let bitmap: ImageBitmap | null = null;
    if (typeof createImageBitmap === "function") {
      try {
        bitmap = await createImageBitmap(file, {
          imageOrientation: "from-image",
          resizeWidth: plan.width,
          resizeHeight: plan.height,
          resizeQuality: "high",
        });
        source = bitmap;
      } catch {
        bitmap = null;
      }
    }
    const canvas = document.createElement("canvas");
    canvas.width = plan.width;
    canvas.height = plan.height;
    try {
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error(`Couldn't process ${label}.`);
      ctx.fillStyle = "#fff"; // JPEG has no alpha
      ctx.fillRect(0, 0, plan.width, plan.height);
      ctx.drawImage(source, 0, 0, plan.width, plan.height);
      const parsed = fromDataUrl(canvas.toDataURL(plan.mimeType, JPEG_QUALITY));
      if (!parsed) throw new Error(`Couldn't process ${label}.`);
      return { name: `${baseName}.jpg`, mimeType: parsed.mimeType, data: parsed.data };
    } finally {
      bitmap?.close();
      // Release the backing store now (iOS caps total canvas memory).
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    URL.revokeObjectURL(p.url);
  }
}
