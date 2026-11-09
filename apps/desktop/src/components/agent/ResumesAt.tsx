import { Timer } from "lucide-react";
import { attempt } from "@/lib/actions";
import { api } from "@/lib/api";
import { notResumingNote, resumeLine, resumesShort, useMinuteNow, waitingToResume } from "@/lib/limitResume";
import type { Agent } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";

/**
 * "Resumes 6:00 PM" for an agent Kvistcode will continue by itself once its rate limit resets;
 * `fallback` (or nothing) otherwise. Plain text, so the parent decides how it truncates.
 */
export function ResumesAt({ agent, fallback = null }: { agent: Agent; fallback?: string | null }) {
  const enabled = useApp((s) => s.settings?.resumeAfterLimit ?? true);
  return <>{resumesShort(agent, enabled) ?? fallback}</>;
}

/**
 * "Resuming automatically at 6:00 PM · in 12 min  Cancel": the full line for a banner or panel, wrapping
 * naturally. The countdown moves at minute granularity and only while this is on screen. When nothing
 * will resume the agent (cancelled, given up) it says why, and when it is not a limit case it is empty.
 */
export function ResumeLine({ agent, className }: { agent: Agent; className?: string }) {
  const enabled = useApp((s) => s.settings?.resumeAfterLimit ?? true);
  const waiting = waitingToResume(agent, enabled);
  const now = useMinuteNow(waiting);
  const line = resumeLine(agent, enabled, now);
  const note = notResumingNote(agent, enabled);
  if (!line && !note) return null;
  if (!line) return <div className={cn("text-meta text-steel", className)}>{note}</div>;
  return (
    <div className={cn("text-caption font-medium leading-snug text-fg/90", className)} data-testid="resume-line">
      <Timer className="mr-1 inline h-3 w-3 -translate-y-px text-warn" aria-hidden />
      {line.text}
      {line.countdown && <span className="whitespace-nowrap font-normal text-muted"> · {line.countdown}</span>}
      {line.tries && <span className="whitespace-nowrap font-normal text-muted"> · {line.tries}</span>}
      <button
        type="button"
        onClick={() => void attempt("Couldn't cancel the automatic resume", () => api.cancelLimitResume(agent.id))}
        className="ml-2 rounded text-meta font-normal text-steel underline decoration-line underline-offset-2 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        Cancel
      </button>
    </div>
  );
}
