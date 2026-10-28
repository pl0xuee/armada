import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Badge({
  children,
  className,
  tone = "neutral",
}: {
  children: ReactNode;
  className?: string;
  tone?: "neutral" | "accent" | "warn" | "ok" | "err" | "violet";
}) {
  const tones = {
    neutral: "border-line-strong bg-raised text-muted",
    accent: "border-accent/30 bg-accent/10 text-accent",
    warn: "border-warn/30 bg-warn/10 text-warn",
    ok: "border-ok/30 bg-ok/10 text-ok",
    err: "border-err/30 bg-err/10 text-err",
    violet: "border-violet/30 bg-violet/10 text-violet",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 text-[11px] font-medium [&_svg]:h-3 [&_svg]:w-3",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function CountBadge({
  count,
  className,
  tone = "warn",
}: {
  count: number;
  className?: string;
  tone?: "warn" | "accent";
}) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular leading-none shadow-[0_0_0_2px_var(--bg-1)]",
        tone === "warn" ? "bg-warn text-warn-fg" : "bg-accent text-accent-fg",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-xl border border-line bg-card edge", className)}>{children}</div>;
}

export function SectionTitle({
  children,
  className,
  right,
}: {
  children: ReactNode;
  className?: string;
  right?: ReactNode;
}) {
  return (
    <div className={cn("mb-2 flex items-center justify-between", className)}>
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-steel">{children}</h3>
      {right}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn("h-4 w-4 animate-spin text-accent", className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
