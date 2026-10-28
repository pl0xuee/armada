import * as C from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export function Checkbox({
  checked,
  onCheckedChange,
  id,
  className,
  disabled,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  id?: string;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return (
    <C.Root
      id={id}
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border border-line-strong bg-base transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent",
        className,
      )}
    >
      <C.Indicator>
        <Check className="h-3 w-3 text-accent-fg" strokeWidth={3} />
      </C.Indicator>
    </C.Root>
  );
}
