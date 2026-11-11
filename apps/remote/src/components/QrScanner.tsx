import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { readQr } from "@/lib/qrScan";
import { Button } from "./ui";

/** Largest side of the picture handed to the decoder (bigger is slower, rarely better). */
const MAX_SIDE = 720;
const SCAN_EVERY_MS = 180;

/**
 * Full-screen camera view that reads one QR code. `onResult` gets its text (the camera is
 * already off by then); `onClose` cancels.
 */
export function QrScanner({
  onResult,
  onClose,
}: {
  onResult: (text: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const done = useRef(onResult);
  done.current = onResult;
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const canvas = document.createElement("canvas");
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    const tick = async () => {
      const video = videoRef.current;
      if (stopped || !video) return;
      if (video.readyState >= 2 && video.videoWidth) {
        const scale = Math.min(
          1,
          MAX_SIDE / Math.max(video.videoWidth, video.videoHeight),
        );
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        canvas
          .getContext("2d", { willReadFrequently: true })
          ?.drawImage(video, 0, 0, canvas.width, canvas.height);
        const text = await readQr(canvas).catch(() => null);
        if (stopped) return;
        if (text) {
          stop();
          done.current(text);
          return;
        }
      }
      timer = setTimeout(() => void tick(), SCAN_EVERY_MS);
    };
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then(async (s) => {
        if (stopped) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = s;
        await video.play().catch(() => undefined);
        void tick();
      })
      .catch((e: unknown) => {
        const name = (e as { name?: string })?.name;
        setProblem(
          name === "NotAllowedError" || name === "SecurityError"
            ? "Kvistcode isn't allowed to use the camera. Allow it in your phone's settings, or paste the pairing link instead."
            : "The camera couldn't start. Paste the pairing link instead.",
        );
      });
    // Leaving the app (to find the code, or locking the phone) turns the camera off: iOS hands
    // back a frozen picture afterwards, so the scan starts fresh from the button instead.
    const onHide = () => {
      if (document.visibilityState === "hidden") close.current();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      stop();
    };
  }, []);

  // On the body: the pairing screen's entry animation would otherwise box in `position: fixed`.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Scan the pairing QR code"
      className="animate-fade fixed inset-0 z-[70] flex flex-col bg-black"
    >
      <div className="relative flex-1 overflow-hidden">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="absolute inset-0 h-full w-full object-cover"
        />
        {!problem && (
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
            aria-hidden
          >
            <div className="h-[62vmin] w-[62vmin] rounded-3xl border-2 border-white/80 shadow-[0_0_0_100vmax_rgba(0,0,0,0.45)]" />
          </div>
        )}
        <p className="absolute inset-x-0 top-[calc(var(--safe-top)+20px)] px-6 text-center text-[15px] font-medium text-white">
          {problem ??
            "Point the camera at the QR code in Kvistcode's Settings, Phone & remote"}
        </p>
      </div>
      <div className="flex justify-center bg-black px-safe pt-4 pb-[calc(var(--safe-bottom)+20px)]">
        <Button
          variant="secondary"
          size="lg"
          icon="x"
          className="w-full max-w-[400px]"
          onClick={onClose}
        >
          Cancel
        </Button>
      </div>
    </div>,
    document.body,
  );
}
