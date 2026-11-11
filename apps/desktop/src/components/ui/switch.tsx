import * as S from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
  "aria-label": ariaLabel,
  id,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  id?: string;
}) {
  return (
    <S.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        "relative inline-flex h-[20px] w-[34px] shrink-0 items-center rounded-full border border-line-strong bg-base transition-colors duration-150 disabled:opacity-45",
        "data-[state=checked]:border-accent/70 data-[state=checked]:bg-accent/85",
        className,
      )}
    >
      <S.Thumb
        className={cn(
          "block h-[14px] w-[14px] translate-x-[2px] rounded-full bg-steel shadow-[0_1px_2px_hsl(var(--shadow-color)/0.35)] transition-transform duration-150",
          "data-[state=checked]:translate-x-[16px] data-[state=checked]:bg-white",
        )}
      />
    </S.Root>
  );
}
