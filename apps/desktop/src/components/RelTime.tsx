import { useState } from "react";
import { useNow } from "@/hooks/useNow";
import { fullDate, fullDateTime, relativeTime, relativeTimeLong } from "@/lib/format";
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
  // A Radix tooltip is ~12 components; most timestamps are never hovered, so mount it on first hover.
  const [hovered, setHovered] = useState(false);
  const time = (
    <time
      dateTime={new Date(ts).toISOString()}
      aria-label={fullDate(ts)}
      className={cn("tabular", className)}
      onPointerEnter={hovered ? undefined : () => setHovered(true)}
    >
      {long ? relativeTimeLong(ts, now) : relativeTime(ts, now)}
    </time>
  );
  return hovered ? (
    <Tooltip content={fullDateTime(ts)} side={side}>
      {time}
    </Tooltip>
  ) : (
    time
  );
}
