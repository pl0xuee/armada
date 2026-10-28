import * as S from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  className,
  "aria-label": ariaLabel,
  disabled,
  id,
}: {
  value: string | undefined;
  onValueChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <S.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <S.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          "flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-line bg-base/60 px-3 text-left text-[13px] text-fg transition-colors hover:border-line-strong focus:border-accent/60 focus:outline-none focus:ring-3 focus:ring-accent/15 disabled:opacity-50 data-[placeholder]:text-steel",
          className,
        )}
      >
        <span className="min-w-0 truncate">
          <S.Value placeholder={placeholder} />
        </span>
        <S.Icon>
          <ChevronDown className="h-3.5 w-3.5 text-steel" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content
          position="popper"
          sideOffset={6}
          className="anim-pop z-[90] max-h-[320px] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-line-strong bg-raised/95 p-1 shadow-[0_16px_48px_-8px_rgba(0,0,0,0.55)] backdrop-blur-xl edge"
        >
          <S.Viewport>
            {options.map((o) => (
              <S.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-lg py-1.5 pl-7 pr-2 text-[13px] text-fg outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-gunmetal"
              >
                <S.ItemIndicator className="absolute left-2">
                  <Check className="h-3.5 w-3.5 text-accent" />
                </S.ItemIndicator>
                <div className="flex min-w-0 flex-col">
                  <S.ItemText>{o.label}</S.ItemText>
                  {o.description && <span className="text-[11.5px] text-steel">{o.description}</span>}
                </div>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}
