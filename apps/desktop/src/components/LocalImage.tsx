import { ImageOff, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { attachmentSrc } from "@/lib/attachments";
import { cachedAgentImage, loadAgentImage } from "@/lib/images";
import type { Attachment } from "@/lib/types";
import { ImageLightbox } from "./ImageLightbox";
import { Tooltip } from "./ui/tooltip";

type State = { state: "idle" | "loading" } | { state: "ok"; image: Attachment } | { state: "error"; error: string };

/** Loads an agent-referenced image when it scrolls into view (IntersectionObserver). */
function useLazyAgentImage(agentId: string, path: string) {
  const ref = useRef<HTMLSpanElement>(null);
  const key = `${agentId}\u0000${path}`;
  const [st, setSt] = useState<State>(() => cachedAgentImage(agentId, path) ?? { state: "idle" });
  // A different image (path or agent changed): start over instead of showing the old one.
  const [forKey, setForKey] = useState(key);
  if (forKey !== key) {
    setForKey(key);
    setSt(cachedAgentImage(agentId, path) ?? { state: "idle" });
  }
  const current = useRef(key);
  current.current = key;

  const idle = st.state === "idle";
  useEffect(() => {
    if (!idle) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        setSt({ state: "loading" });
        void loadAgentImage(agentId, path).then((r) => current.current === key && setSt(r));
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [agentId, path, key, idle]);

  const retry = useCallback(() => {
    setSt({ state: "loading" });
    void loadAgentImage(agentId, path, true).then((r) => current.current === key && setSt(r));
  }, [agentId, path, key]);

  return { ref, st, retry };
}

function Chip({ path, alt, error, onRetry }: { path: string; alt: string; error: string; onRetry: () => void }) {
  return (
    <span className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md border border-line-strong bg-raised py-0.5 pl-1.5 pr-0.5 align-middle text-[12px] text-muted">
      <Tooltip content={error}>
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <ImageOff className="h-3.5 w-3.5 shrink-0 text-steel" />
          <span className="truncate">
            Image{alt ? ` “${alt}”` : ""}: {path}
          </span>
        </span>
      </Tooltip>
      <button
        type="button"
        onClick={onRetry}
        aria-label={`Retry loading ${alt || path}`}
        className="inline-flex h-5 shrink-0 items-center gap-1 rounded px-1 text-[11px] text-accent transition-colors hover:bg-gunmetal"
      >
        <RotateCw className="h-3 w-3" /> Retry
      </button>
    </span>
  );
}

/** Inline image from the agent's files (markdown `![alt](path)`); falls back to a chip on error. */
export function LocalImage({ agentId, path, alt }: { agentId: string; path: string; alt: string }) {
  const { ref, st, retry } = useLazyAgentImage(agentId, path);
  const [open, setOpen] = useState<number | null>(null);
  if (st.state === "error") return <Chip path={path} alt={alt} error={st.error} onRetry={retry} />;
  return (
    <span ref={ref} className="my-1 block">
      {st.state === "ok" ? (
        <>
          <button
            type="button"
            onClick={() => setOpen(0)}
            aria-label={`View ${alt || path}`}
            className="block overflow-hidden rounded-xl border border-line-strong bg-base transition-transform duration-150 hover:scale-[1.005] active:scale-[0.995]"
          >
            <img
              src={attachmentSrc(st.image)}
              alt={alt || path}
              decoding="async"
              className="block max-h-[320px] w-auto max-w-full object-contain"
              draggable={false}
            />
          </button>
          <ImageLightbox images={[st.image]} index={open} onIndexChange={setOpen} />
        </>
      ) : (
        <span
          className="skeleton block h-[180px] w-[min(100%,320px)] rounded-xl"
          aria-label={`Loading ${alt || path}`}
        />
      )}
    </span>
  );
}

/** Small lazy thumbnail for an image file in a tool call's locations. */
export function LocationThumb({
  agentId,
  path,
  onOpen,
}: {
  agentId: string;
  path: string;
  onOpen: (image: Attachment) => void;
}) {
  const { ref, st, retry } = useLazyAgentImage(agentId, path);
  const name = path.split(/[\\/]/).pop() ?? path;
  return (
    <span ref={ref} className="block">
      {st.state === "ok" ? (
        <button
          type="button"
          onClick={() => onOpen(st.image)}
          title={path}
          aria-label={`View ${name}`}
          className="block h-[88px] overflow-hidden rounded-lg border border-line-strong bg-base transition-transform duration-150 hover:scale-[1.03] active:scale-[0.98]"
        >
          <img
            src={attachmentSrc(st.image)}
            alt={name}
            decoding="async"
            className="h-full w-auto object-cover"
            draggable={false}
          />
        </button>
      ) : st.state === "error" ? (
        <Tooltip content={`${st.error} · click to retry`}>
          <button
            type="button"
            onClick={retry}
            aria-label={`Couldn't load ${name}. Retry`}
            className="flex h-[88px] w-[120px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line-strong px-2 text-center text-[10.5px] text-steel transition-colors hover:border-accent/50 hover:text-fg"
          >
            <ImageOff className="h-4 w-4" />
            <span className="max-w-full truncate">{name}</span>
            <span className="inline-flex items-center gap-1 text-accent">
              <RotateCw className="h-3 w-3" /> Retry
            </span>
          </button>
        </Tooltip>
      ) : (
        <span className="skeleton block h-[88px] w-[140px] rounded-lg" aria-label={`Loading ${name}`} />
      )}
    </span>
  );
}
