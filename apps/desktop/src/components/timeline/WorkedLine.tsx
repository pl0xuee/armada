import { ChevronRight } from "lucide-react";
import { memo, useMemo } from "react";
import { pluralize } from "@/lib/format";
import type { TimelineItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatElapsed } from "./thinking";
import { summarizeFold } from "./turnFold";

/**
 * Minimal look: the one line a finished turn's steps fold into ("Worked for 4m 02s"), with what they
 * were on the right. Opens to show the steps as they are (the timeline renders them as the next rows).
 */
export const WorkedLine = memo(function WorkedLine({
  foldId,
  items,
  durationMs,
  open,
  onToggle,
}: {
  foldId: string;
  /** The fold's steps. */
  items: readonly TimelineItem[];
  /** The turn's duration when it is known; otherwise the line counts the steps. */
  durationMs: number | null;
  open: boolean;
  onToggle: (foldId: string) => void;
}) {
  const { text, steps, failed } = useMemo(() => summarizeFold(items), [items]);
  const timed = durationMs !== null && durationMs >= 1000;
  return (
    <button
      type="button"
      onClick={() => onToggle(foldId)}
      aria-expanded={open}
      className="group/worked flex h-[34px] w-full items-center gap-1.5 border-b border-line text-left text-[13.5px] text-steel transition-colors hover:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      <span className="shrink-0 tabular">
        {timed
          ? `Worked for ${formatElapsed(durationMs)}`
          : steps > 0
            ? `Worked · ${pluralize(steps, "step")}`
            : "Worked"}
      </span>
      <ChevronRight
        aria-hidden
        className={cn("h-3 w-3 shrink-0 transition-transform duration-150", open && "rotate-90")}
      />
      <span className="ml-auto min-w-0 truncate pl-3 text-small" title={text}>
        {text}
      </span>
      {failed > 0 && (
        <span className="shrink-0 text-small text-err/90" aria-label={`${failed} failed`}>
          · {failed} failed
        </span>
      )}
    </button>
  );
});
