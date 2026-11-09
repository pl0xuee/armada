import { ChevronUp, CircleCheck, CircleX } from "lucide-react";
import { useMemo, useState } from "react";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import { subagentStrip, type SubagentRun, type SubagentStrip as StripData } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";
import { formatElapsed } from "../timeline/thinking";
import { useLinger, useRetained } from "./pinnedFold";
import { SubagentList } from "./SubagentList";
import { useSubagentRuns } from "./useSubagents";

/** How long the strip stays, with a check, after the last sub-agent finished. */
const LINGER_MS = 3000;

/** Ticks on its own, so the once-a-second render stays inside this one text node. */
export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useVisibleInterval(() => setNow(Date.now()), 1000);
  return <span className="shrink-0 text-meta text-steel tabular">{formatElapsed(now - since)}</span>;
}

/**
 * What the pinned sub-agent row shows: present while sub-agents run, and for a moment (with a check)
 * after the last one finished. `strip` keeps the last summary while the row folds away.
 */
export function useSubagentPin(agentId: string): {
  open: boolean;
  runs: readonly SubagentRun[];
  strip: StripData | null;
} {
  const runs = useSubagentRuns(agentId);
  const current = useMemo(() => subagentStrip(runs), [runs]);
  const lingering = useLinger(current.running > 0, LINGER_MS);
  const open = current.running > 0 || (lingering && current.finished > 0);
  const strip = useRetained(current.focus ? current : null);
  return { open, runs, strip };
}

/** The pinned sub-agent row: one line, with each sub-agent listed on demand. */
export function SubagentRow({
  agentId,
  runs,
  strip,
  compact,
}: {
  agentId: string;
  runs: readonly SubagentRun[];
  strip: StripData;
  compact: boolean;
}) {
  const [listOpen, setListOpen] = useState(false);
  const active = strip.running > 0;
  const failed = !active && strip.failed > 0 && strip.failed === strip.finished;
  const total = strip.running + strip.finished;
  const kind = total === 1 ? strip.focus?.kind : null;
  const reveal = (itemId: string) => useUi.getState().revealItem(agentId, itemId);

  return (
    <section aria-label="Sub-agents">
      <span role="status" className="sr-only">
        {strip.headline}
      </span>
      <div className={cn("flex items-center", compact ? "h-8" : "h-9")}>
        <button
          type="button"
          onClick={() => strip.focus && reveal(strip.focus.itemId)}
          title="Show in conversation"
          className={cn(
            "flex h-full min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:bg-raised/50 focus-visible:outline-offset-[-2px]",
            compact ? "px-3" : "px-3.5",
          )}
        >
          {active ? (
            <span className="relative flex h-2 w-2 shrink-0 items-center justify-center" aria-hidden>
              <span className="absolute inset-0 rounded-full bg-accent animate-pulse-ring" />
              <span className="relative h-2 w-2 rounded-full bg-accent" />
            </span>
          ) : failed ? (
            <CircleX className="h-3.5 w-3.5 shrink-0 text-err" aria-hidden />
          ) : (
            <CircleCheck className="h-3.5 w-3.5 shrink-0 text-ok" aria-hidden />
          )}
          {kind && !compact && (
            <span className="shrink-0 rounded border border-violet/30 bg-violet/10 px-1 eyebrow text-violet">
              {kind}
            </span>
          )}
          <span className="min-w-0 shrink-0 truncate text-caption font-medium text-fg">{strip.headline}</span>
          {active && strip.step && !compact && (
            <span className="min-w-0 flex-1 truncate text-meta text-steel" title={strip.step}>
              <span aria-hidden className="mr-2 text-line-strong">
                ·
              </span>
              {strip.step}
            </span>
          )}
        </button>
        {active && strip.since !== null && (
          <span className="pr-2.5">
            <Elapsed since={strip.since} />
          </span>
        )}
        {total > 1 && (
          <button
            type="button"
            aria-expanded={listOpen}
            aria-label={listOpen ? "Hide sub-agent list" : "Show each sub-agent"}
            title={listOpen ? "Hide list" : "Show each sub-agent"}
            onClick={() => setListOpen((v) => !v)}
            className="flex h-full w-9 shrink-0 items-center justify-center text-steel transition-colors hover:bg-raised/50 hover:text-fg focus-visible:outline-offset-[-2px]"
          >
            <ChevronUp className={cn("h-3.5 w-3.5 transition-transform duration-150", !listOpen && "rotate-180")} />
          </button>
        )}
      </div>
      {listOpen && total > 1 && (
        <div className={cn("overflow-y-auto border-t border-line px-1 py-1", compact ? "max-h-32" : "max-h-48")}>
          <SubagentList runs={runs} onSelect={(r) => reveal(r.itemId)} />
        </div>
      )}
    </section>
  );
}
