/**
 * Reading a pairing QR code with the camera, inside the app. The Home Screen app on iPhone has
 * its own storage, and the Camera app opens a scanned link in Safari, so it can only pair by
 * scanning from inside itself. Browsers only allow the camera on secure (https) addresses, such
 * as Tailscale's; on a plain http LAN address `canScanQr` is false and pasting the link remains.
 */

import { pairCodeFromHash } from "./auth";

/** The camera is available here (secure address, a browser with getUserMedia). */
export function canScanQr(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined")
    return false;
  return (
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

/** Why the camera isn't offered (null when it is). */
export function scanUnavailableReason(): "insecure" | "unsupported" | null {
  if (canScanQr()) return null;
  return typeof window !== "undefined" && !window.isSecureContext
    ? "insecure"
    : "unsupported";
}

type Detector = {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
};

let detector: Detector | null | undefined;

/** The browser's own QR reader when it has one (Chrome on Android); else jsQR. */
function nativeDetector(): Detector | null {
  if (detector !== undefined) return detector;
  const Ctor = (
    globalThis as {
      BarcodeDetector?: new (o: { formats: string[] }) => Detector;
    }
  ).BarcodeDetector;
  try {
    detector = Ctor ? new Ctor({ formats: ["qr_code"] }) : null;
  } catch {
    detector = null;
  }
  return detector;
}

/** The text of a QR code in the canvas's picture, if it holds one. */
export async function readQr(
  canvas: HTMLCanvasElement,
): Promise<string | null> {
  const native = nativeDetector();
  if (native) {
    try {
      const found = await native.detect(canvas);
      if (found[0]?.rawValue) return found[0].rawValue;
      return null;
    } catch {
      detector = null; // fall back to jsQR from now on
    }
  }
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const { data, width, height } = ctx.getImageData(
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const { default: jsQR } = await import("jsqr");
  return (
    jsQR(data, width, height, { inversionAttempts: "dontInvert" })?.data ?? null
  );
}

/** The one-time pairing code in a scanned pairing link, whatever address it names. */
export function scannedPairCode(text: string): string | null {
  try {
    const url = new URL(text.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return pairCodeFromHash(url.hash);
  } catch {
    return null;
  }
}
