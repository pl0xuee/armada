import { useNow } from "@/hooks/useNow";
import { fullDate, relativeTime, relativeTimeLong } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Tooltip } from "./ui/tooltip";

/** Relative timestamp ("5m") with the absolute time in a tooltip and a <time> element for a11y. */
export function RelTime({
  ts,
  long,
  className,
  side = "top",
}: {
  ts: number;
  long?: boolean;
  className?: string;
  side?: "top" | "right" | "bottom" | "left";
}) {
  const now = useNow();
  return (
    <Tooltip content={new Date(ts).toLocaleString()} side={side}>
      <time dateTime={new Date(ts).toISOString()} aria-label={fullDate(ts)} className={cn("tabular", className)}>
        {long ? relativeTimeLong(ts, now) : relativeTime(ts, now)}
      </time>
    </Tooltip>
  );
}
