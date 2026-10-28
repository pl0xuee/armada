import { createContext, useContext, useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/api";
import { fetchLocalImage } from "@/lib/controller";
import { cachedLocalImage } from "@/lib/localImages";
import type { Attachment } from "@/lib/types";
import { Icon, Spinner } from "./Icon";
import { ImageStrip } from "./Images";

/** Which agent's files local image paths refer to (owners and that agent's viewers can fetch them). */
export const ImageSource = createContext<string | null>(null);

/**
 * A screenshot the agent referenced by path. Loads when it scrolls into
 * view (or on tap), then shows as a thumbnail that opens full screen.
 */
export function LocalImage({ path, alt }: { path: string; alt?: string }) {
  const agentId = useContext(ImageSource);
  const ref = useRef<HTMLButtonElement>(null);
  const [img, setImg] = useState<Attachment | null>(() => (agentId ? (cachedLocalImage(agentId, path) ?? null) : null));
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState("");
  const name = path.split(/[\\/]/).pop() || path;

  const load = () => {
    if (!agentId || state === "loading") return;
    setState("loading");
    fetchLocalImage(agentId, path)
      .then((a) => {
        setImg(a);
        setState("idle");
      })
      .catch((e: unknown) => {
        setError(errorMessage(e));
        setState("error");
      });
  };

  useEffect(() => {
    const el = ref.current;
    if (img || !agentId || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          load();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, path, img]);

  if (img) return <ImageStrip images={[{ ...img, name: img.name || name }]} className="my-1" />;
  if (!agentId) return <code className="md-code">{alt || path}</code>;
  return (
    <button
      ref={ref}
      type="button"
      onClick={load}
      title={path}
      className="press my-1 flex h-24 w-[180px] max-w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-line-strong bg-code px-3 text-center text-[12px] text-muted"
    >
      {state === "loading" ? <Spinner size={16} /> : <Icon name={state === "error" ? "alertCircle" : "image"} size={18} className="text-steel" />}
      <span className="w-full truncate font-mono text-[11.5px]">{name}</span>
      {state === "error" && <span className="line-clamp-2 text-err">{error || "Couldn't load"} · Tap to retry</span>}
    </button>
  );
}
