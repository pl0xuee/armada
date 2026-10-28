import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Icon, Spinner, type IconName } from "./Icon";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "ok" | "warn" | "outline";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_6px_20px_-8px_color-mix(in_srgb,var(--accent)_70%,transparent)]",
  secondary: "bg-raised text-fg border border-line-strong edge",
  ghost: "text-muted active:bg-raised",
  danger: "bg-err/12 text-err border border-err/35",
  ok: "bg-ok/12 text-ok border border-ok/35",
  warn: "bg-warn text-warn-fg font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]",
  outline: "border border-line-strong text-fg",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-[13px] rounded-[10px] gap-1.5",
  md: "h-11 px-4 text-[14.5px] rounded-xl gap-2",
  lg: "h-[52px] px-5 text-[15.5px] rounded-[14px] gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  loading?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, loading, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "press relative inline-flex min-w-0 shrink-0 items-center justify-center font-medium whitespace-nowrap select-none disabled:opacity-45",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={size === "sm" ? 14 : 16} /> : icon ? <Icon name={icon} size={size === "sm" ? 16 : 18} /> : null}
      {children}
    </button>
  );
});

/** 44×44 icon-only button for headers and toolbars. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; badge?: number | null; tone?: "default" | "warn" }
>(function IconButton({ icon, label, badge, tone = "default", className, type = "button", ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={badge ? `${label}, ${badge} waiting` : label}
      className={cn(
        "press relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted active:bg-raised active:text-fg",
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={22} />
      {badge ? (
        <span
          className={cn(
            "absolute top-1 right-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[11px] font-bold tabular ring-2 ring-base",
            tone === "warn" ? "bg-warn text-warn-fg" : "bg-accent text-accent-fg",
          )}
          aria-hidden
        >
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </button>
  );
});
