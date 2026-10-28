import { Check, OctagonX, Square } from "lucide-react";
import { useState } from "react";
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
  return (
    <div role="status" className="flex items-center gap-2.5 px-1 pb-2 pt-1">
      <span
        aria-hidden
        className={cn("inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border", tone.ring)}
        style={
          fresh && end.tone === "done" ? { animation: "var(--animate-done-pop), var(--animate-done-glow)" } : undefined
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
        className={cn("flex items-baseline gap-1.5 text-[12.5px] font-medium", tone.text, fresh && "animate-think-in")}
      >
        {end.label}
        {end.elapsedMs !== null && end.elapsedMs >= 1000 && (
          <span className="tabular text-2xs font-normal text-steel">· {formatElapsed(end.elapsedMs)}</span>
        )}
      </span>
    </div>
  );
}
