import { clockTime } from "@/lib/format";
import type { AccountUsage, UsageWindow } from "@/lib/types";
import { cn } from "@/lib/utils";

export function windowLabel(w: UsageWindow): string {
  const m = w.windowMins;
  if (m === null) return "Usage";
  if (m === 10080) return "Weekly";
  if (m === 1440) return "Daily";
  if (m % 60 === 0) return `${m / 60}h window`;
  return `${m}m window`;
}

export function resetLabel(resetsAt: number | null, now = Date.now()): string | null {
  if (resetsAt === null) return null;
  if (resetsAt - now < 24 * 3600_000) return `resets ${clockTime(resetsAt)}`;
  return `resets ${new Date(resetsAt).toLocaleDateString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}

function tone(pct: number) {
  return pct >= 90 ? "bg-err" : pct >= 70 ? "bg-warn" : "bg-accent";
}

function Meter({ w, compact }: { w: UsageWindow; compact?: boolean }) {
  const pct = Math.max(0, Math.min(100, Math.round(w.usedPercent)));
  const reset = resetLabel(w.resetsAt);
  return (
    <div className={cn("min-w-0", compact ? "w-full" : "w-full max-w-[240px]")}>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="truncate text-steel">
          {windowLabel(w)}
          {reset && !compact && <span className="text-steel/80"> · {reset}</span>}
        </span>
        <span className={cn("font-medium tabular", pct >= 90 ? "text-err" : pct >= 70 ? "text-warn" : "text-fg")}>
          {pct}%
        </span>
      </div>
      <div
        className="mt-1 h-1 overflow-hidden rounded-full bg-raised"
        role="meter"
        aria-label={`${windowLabel(w)} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div
          className={cn("h-full origin-left rounded-full transition-transform duration-300", tone(pct))}
          style={{ transform: `scaleX(${pct / 100})` }}
        />
      </div>
      {reset && compact && <div className="mt-0.5 text-[10.5px] text-steel">{reset}</div>}
    </div>
  );
}

/** Rate-limit window meters reported by the provider (Codex today). Renders nothing without data. */
export function UsageMeters({
  usage,
  compact,
  className,
}: {
  usage: AccountUsage | null | undefined;
  compact?: boolean;
  className?: string;
}) {
  if (!usage || (!usage.primary && !usage.secondary)) return null;
  return (
    <div className={cn("flex gap-4", compact && "flex-col gap-2", className)}>
      {usage.primary && <Meter w={usage.primary} compact={compact} />}
      {usage.secondary && <Meter w={usage.secondary} compact={compact} />}
    </div>
  );
}
