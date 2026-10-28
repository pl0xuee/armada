import { m } from "motion/react";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { onRadioGroupKeyDown } from "./radioKeys";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = "md",
  "aria-label": ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentOption<T>[];
  className?: string;
  size?: "sm" | "md";
  "aria-label"?: string;
}) {
  const id = useId();
  const hasActive = options.some((o) => o.value === value && !o.disabled);
  const firstEnabled = options.find((o) => !o.disabled)?.value;
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onRadioGroupKeyDown}
      className={cn("inline-flex rounded-xl border border-line bg-base/70 p-0.5", className)}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            // Roving tabindex: only the checked radio is in the tab order (first enabled one if none is).
            tabIndex={active || (!hasActive && o.value === firstEnabled) ? 0 : -1}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-[10px] font-medium transition-colors disabled:opacity-40",
              size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]",
              active ? "text-fg" : "text-muted hover:text-fg",
            )}
          >
            {active && (
              <m.span
                layoutId={`seg-${id}`}
                transition={{ type: "spring", stiffness: 500, damping: 38 }}
                className="absolute inset-0 rounded-[10px] border border-line-strong bg-raised edge"
              />
            )}
            <span className="relative z-10 flex items-center gap-1.5">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
