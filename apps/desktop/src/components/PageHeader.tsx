import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Consistent page header for full-width views. */
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
    <div className={cn("shrink-0 border-b border-line bg-panel/40 px-6 pb-4 pt-5", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {icon && (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-line-strong bg-gradient-to-b from-raised to-card text-steel edge-strong [&_svg]:h-[18px] [&_svg]:w-[18px]">
              {icon}
            </div>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-[20px] font-semibold leading-tight tracking-tight text-fg">{title}</h1>
            {subtitle && <p className="mt-0.5 truncate text-[12.5px] text-muted">{subtitle}</p>}
          </div>
        </div>
        {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}
