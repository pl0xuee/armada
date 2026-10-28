import type { ReactNode } from "react";

export function KpiTile({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon: ReactNode;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-line bg-card px-4 py-3.5 edge">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-6 -top-10 h-24 w-24 rounded-full bg-accent/[0.06] blur-2xl"
      />
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-steel [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2 text-[24px] font-semibold leading-none tracking-tight text-fg tabular">{value}</div>
      {sub && <div className="mt-1.5 truncate text-[11.5px] text-muted">{sub}</div>}
    </div>
  );
}
