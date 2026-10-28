import { Bot, CircleCheck, CircleX } from "lucide-react";
import { useEffect, useState } from "react";
import type { SubagentRun } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { formatElapsed } from "../timeline/thinking";
import { Spinner } from "../ui/misc";

/** Ticks once a second while mounted, for elapsed times. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Sub-agents of one agent: running ones first, then those finished this turn (dimmed). */
export function SubagentList({
  runs,
  onSelect,
  className,
}: {
  runs: readonly SubagentRun[];
  onSelect: (run: SubagentRun) => void;
  className?: string;
}) {
  const now = useNow(runs.some((r) => r.state === "running"));
  const ordered = [...runs.filter((r) => r.state === "running"), ...runs.filter((r) => r.state !== "running")];
  return (
    <ul className={cn("space-y-0.5", className)}>
      {ordered.map((r) => {
        const running = r.state === "running";
        return (
          <li key={r.itemId}>
            <button
              type="button"
              onClick={() => onSelect(r)}
              className={cn(
                "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-gunmetal",
                !running && "opacity-60 hover:opacity-100",
              )}
            >
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                {running ? (
                  <Spinner className="h-3.5 w-3.5" />
                ) : r.state === "failed" ? (
                  <CircleX className="h-3.5 w-3.5 text-err" aria-label="Failed" />
                ) : (
                  <CircleCheck className="h-3.5 w-3.5 text-ok/80" aria-label="Done" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="inline-flex h-4 shrink-0 items-center gap-1 rounded border border-violet/30 bg-violet/10 px-1 text-[10px] font-semibold uppercase tracking-[0.05em] text-violet">
                    <Bot className="h-2.5 w-2.5" />
                    {r.kind ?? "Sub-agent"}
                  </span>
                  {running && r.background && <span className="text-[10.5px] text-steel">background</span>}
                  {running && (
                    <span className="ml-auto shrink-0 text-[11px] text-steel tabular">
                      {formatElapsed(now - r.startedAt)}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block truncate text-[12.5px] text-fg" title={r.description}>
                  {r.description}
                </span>
                {running && r.step && (
                  <span className="block truncate text-[11.5px] text-steel" title={r.step}>
                    {r.step}
                  </span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
