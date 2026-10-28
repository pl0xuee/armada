import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      <div className="relative mb-5">
        <div className="absolute inset-0 -m-6 rounded-full bg-accent/10 blur-2xl" aria-hidden />
        <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-line-strong bg-gradient-to-b from-raised to-card text-steel shadow-lg shadow-black/30 edge-strong [&_svg]:h-6 [&_svg]:w-6">
          {icon}
        </div>
      </div>
      <h3 className="text-[15px] font-semibold tracking-tight text-fg">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
