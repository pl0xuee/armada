import { Slot } from "@radix-ui/react-slot";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const VARIANTS = {
  primary:
    "bg-accent text-accent-fg font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_0_0_1px_color-mix(in_srgb,var(--accent)_60%,black),0_4px_14px_-4px_color-mix(in_srgb,var(--accent)_55%,transparent)] hover:brightness-110",
  secondary:
    "bg-raised text-fg border border-line-strong edge hover:bg-gunmetal hover:border-[color-mix(in_srgb,var(--steel)_40%,var(--border))]",
  ghost: "text-muted hover:text-fg hover:bg-raised",
  outline: "border border-line text-fg hover:bg-raised hover:border-line-strong",
  danger: "bg-err/12 text-err border border-err/30 hover:bg-err/20 hover:border-err/50",
  "danger-solid": "bg-err text-white font-medium hover:brightness-110 shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]",
  warn: "bg-warn text-warn-fg font-medium hover:brightness-110 shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_4px_14px_-4px_color-mix(in_srgb,var(--warn)_60%,transparent)]",
  ok: "bg-ok/12 text-ok border border-ok/30 hover:bg-ok/20",
} as const;

const SIZES = {
  xs: "h-6 px-2 text-xs gap-1 rounded-md",
  sm: "h-7 px-2.5 text-[12.5px] gap-1.5 rounded-lg",
  md: "h-8 px-3 text-[13px] gap-2 rounded-lg",
  lg: "h-10 px-4 text-sm gap-2 rounded-xl",
  icon: "h-8 w-8 rounded-lg",
  "icon-sm": "h-7 w-7 rounded-md",
  "icon-xs": "h-6 w-6 rounded-md",
} as const;

export type ButtonVariant = keyof typeof VARIANTS;
export type ButtonSize = keyof typeof SIZES;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "secondary", size = "md", asChild, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        type={asChild ? undefined : (type ?? "button")}
        className={cn(
          "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap transition-[transform,background-color,border-color,color,filter,opacity] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0",
          VARIANTS[variant],
          SIZES[size],
          className,
        )}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
