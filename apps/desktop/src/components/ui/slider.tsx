import * as S from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

export function Slider({
  value,
  onValueChange,
  onValueCommit,
  min = 0,
  max = 1,
  step = 0.01,
  className,
  "aria-label": ariaLabel,
  disabled,
}: {
  value: number;
  onValueChange: (v: number) => void;
  onValueCommit?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  "aria-label"?: string;
  disabled?: boolean;
}) {
  return (
    <S.Root
      value={[value]}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={(v) => onValueChange(v[0])}
      onValueCommit={(v) => onValueCommit?.(v[0])}
      className={cn(
        "relative flex h-5 w-full touch-none select-none items-center data-[disabled]:opacity-40",
        className,
      )}
    >
      <S.Track className="relative h-1 grow overflow-hidden rounded-full bg-raised">
        <S.Range className="absolute h-full rounded-full bg-accent" />
      </S.Track>
      <S.Thumb
        aria-label={ariaLabel}
        className="block h-3.5 w-3.5 rounded-full border border-white/40 bg-white shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent)_20%,transparent)] transition-transform hover:scale-110 focus:outline-none focus-visible:shadow-[0_0_0_5px_color-mix(in_srgb,var(--accent)_40%,transparent)]"
      />
    </S.Root>
  );
}
