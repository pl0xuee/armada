import { Layers, Minus, Plus } from "lucide-react";
import { MAX_PARALLEL_AGENTS } from "@/lib/launchDefaults";
import { cn } from "@/lib/utils";
import { Tooltip } from "../ui/tooltip";

/**
 * How many separate agents to start on this task in the same project (1 to 8). More than one
 * means each runs in its own worktree and branch, so they can't overwrite each other.
 */
export function AgentCount({
  value,
  onChange,
  disabled,
  compact = false,
  className,
}: {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const step =
    "flex h-5 w-5 items-center justify-center rounded-md text-muted enabled:hover:bg-gunmetal enabled:hover:text-fg disabled:opacity-35 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent/25";
  return (
    <Tooltip content={`Start up to ${MAX_PARALLEL_AGENTS} separate agents on this task, each in its own worktree`}>
      <div
        role="group"
        aria-label="Number of agents"
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-lg border bg-base/50 pl-2 pr-1 text-[12px] text-fg/90 transition-colors",
          value > 1 ? "border-accent/40 bg-accent/[0.07]" : "border-line",
          className,
        )}
      >
        <Layers className="h-3.5 w-3.5 text-steel" aria-hidden />
        <span className={cn(compact && "sr-only")}>Agents</span>
        <button
          type="button"
          className={step}
          aria-label="Fewer agents"
          disabled={disabled || value <= 1}
          onClick={() => onChange(value - 1)}
        >
          <Minus className="h-3 w-3" />
        </button>
        <span className="min-w-3 text-center font-medium tabular" aria-live="polite">
          {value}
        </span>
        <button
          type="button"
          className={step}
          aria-label="More agents"
          disabled={disabled || value >= MAX_PARALLEL_AGENTS}
          onClick={() => onChange(value + 1)}
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>
    </Tooltip>
  );
}
