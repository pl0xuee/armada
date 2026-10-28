import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button, type ButtonVariant } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

/**
 * Consistent page header for full-width views. It is its own container
 * (`@container/ph`), so header actions can collapse to icon buttons based on the
 * real pane width rather than the viewport.
 */
export function PageHeader({
  title,
  subtitle,
  icon,
  right,
  children,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  right?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "@container/ph shrink-0 border-b border-line bg-panel/40 px-4 pb-3.5 pt-4 @2xl/ph:px-6 @2xl/ph:pb-4 @2xl/ph:pt-5",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {icon && (
            <div className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-line-strong bg-gradient-to-b from-raised to-card text-steel edge-strong @md/ph:flex [&_svg]:h-[18px] [&_svg]:w-[18px]">
              {icon}
            </div>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-[18px] font-semibold leading-tight tracking-tight text-fg @2xl/ph:text-[20px]">
              {title}
            </h1>
            {subtitle && <p className="mt-0.5 truncate text-[12.5px] text-muted">{subtitle}</p>}
          </div>
        </div>
        {right && <div className="flex shrink-0 items-center gap-1.5 @xl/ph:gap-2">{right}</div>}
      </div>
      {children && <div className="mt-3.5 @2xl/ph:mt-4">{children}</div>}
    </div>
  );
}

/**
 * Header action: icon + label on roomy panes, icon-only (with tooltip and an
 * accessible name) on narrow ones. Must be rendered inside a PageHeader.
 */
export function HeaderAction({
  icon,
  label,
  onClick,
  variant = "secondary",
  disabled,
  hint,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  /** Extra text after the label, e.g. a shortcut hint (wide panes only). */
  hint?: ReactNode;
}) {
  return (
    <Tooltip content={label}>
      <Button
        variant={variant}
        size="sm"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className="h-8 w-8 px-0 @xl/ph:h-7 @xl/ph:w-auto @xl/ph:px-2.5"
      >
        {icon}
        <span className="hidden @xl/ph:inline">{label}</span>
        {hint && <span className="ml-1 hidden text-[10.5px] opacity-70 @3xl/ph:inline">{hint}</span>}
      </Button>
    </Tooltip>
  );
}
