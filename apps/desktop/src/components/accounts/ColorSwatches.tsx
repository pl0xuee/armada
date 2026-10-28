import { Check } from "lucide-react";
import { ACCOUNT_COLORS } from "@/lib/providers";
import { cn } from "@/lib/utils";

export function ColorSwatches({
  value,
  onChange,
  className,
  "aria-label": ariaLabel = "Account color",
}: {
  value: string;
  onChange: (c: string) => void;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn("flex flex-wrap gap-2", className)}>
      {ACCOUNT_COLORS.map((c) => {
        const active = c.toLowerCase() === value.toLowerCase();
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={c}
            onClick={() => onChange(c)}
            className={cn(
              "relative flex h-7 w-7 items-center justify-center rounded-full transition-transform duration-150 hover:scale-110 active:scale-95",
            )}
            style={{
              background: `radial-gradient(circle at 30% 25%, color-mix(in srgb, ${c} 70%, white), ${c})`,
              boxShadow: active
                ? `0 0 0 2px var(--bg-2), 0 0 0 3.5px ${c}, 0 0 14px color-mix(in srgb, ${c} 50%, transparent)`
                : "inset 0 1px 0 rgba(255,255,255,0.25)",
            }}
          >
            {active && <Check className="h-3.5 w-3.5 text-black/70" strokeWidth={3} />}
          </button>
        );
      })}
    </div>
  );
}
