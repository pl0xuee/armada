import { Check, OctagonX, Square } from "lucide-react";
import { useState } from "react";
import { useMinimal } from "@/hooks/useLook";
import { cn } from "@/lib/utils";
import { formatElapsed, type TurnEnd } from "./thinking";

const TONE = {
  done: { text: "text-ok", ring: "border-ok/40 bg-ok/15 text-ok" },
  error: { text: "text-err", ring: "border-err/40 bg-err/12 text-err" },
  stopped: { text: "text-steel", ring: "border-line-strong bg-raised text-steel" },
} as const;

/**
 * Compact end-of-turn line that takes the thinking indicator's place: same box, so the spinner
 * reads as morphing into a drawn check (and a soft glow when the turn just ended).
 */
export function TurnEndLine({ end, lastActivityAt }: { end: TurnEnd; lastActivityAt: number }) {
  // Animate only when it appears live, not when an old conversation is opened.
  const [fresh] = useState(() => Date.now() - lastActivityAt < 10_000);
  const tone = TONE[end.tone];
  // Minimal: a plain mark, no ring, and no glow that animates.
  const minimal = useMinimal();
  return (
    <div role="status" className="flex items-center gap-2.5 pb-2 pt-1 minimal:min-h-9 minimal:gap-2">
      <span
        aria-hidden
        className={cn(
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border minimal:h-3.5 minimal:w-3.5 minimal:border-0 minimal:bg-transparent",
          tone.ring,
        )}
        style={
          fresh && end.tone === "done" && !minimal
            ? { animation: "var(--animate-done-pop), var(--animate-done-glow)" }
            : undefined
        }
      >
        {end.tone === "done" ? (
          <Check
            className="h-3.5 w-3.5"
            strokeWidth={3}
            style={fresh ? { strokeDasharray: 24, animation: "var(--animate-done-draw)" } : undefined}
          />
        ) : end.tone === "error" ? (
          <OctagonX className="h-3.5 w-3.5" />
        ) : (
          <Square className="h-3 w-3" />
        )}
      </span>
      <span
        className={cn(
          "flex items-baseline gap-1.5 text-small font-medium minimal:text-[13.5px] minimal:font-normal",
          tone.text,
          fresh && "animate-think-in",
        )}
      >
        {end.label}
        {end.elapsedMs !== null && end.elapsedMs >= 1000 && (
          <span className="tabular text-2xs font-normal text-steel">· {formatElapsed(end.elapsedMs)}</span>
        )}
        {end.note && <span className="text-2xs font-normal text-accent">· {end.note}</span>}
      </span>
    </div>
  );
}

/** Calm closing line once the background work that outlived the turn is over too. */
export function EverythingFinishedLine({ detail }: { detail?: string }) {
  return (
    <div role="status" className="flex items-center gap-2.5 pb-2 pt-1 minimal:min-h-9 minimal:gap-2">
      <span
        aria-hidden
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-ok/40 bg-ok/15 text-ok minimal:h-3.5 minimal:w-3.5 minimal:border-0 minimal:bg-transparent"
      >
        <Check className="h-3.5 w-3.5" strokeWidth={3} />
      </span>
      <span className="flex items-baseline gap-1.5 text-small font-medium text-ok minimal:text-[13.5px] minimal:font-normal">
        Everything finished
        {detail && <span className="text-2xs font-normal text-steel">· {detail}</span>}
      </span>
    </div>
  );
}
