import { Fragment, type ReactNode } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface BarDatum {
  key: string;
  label: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  value: number;
  color: string;
  /** Rendered value text (already formatted). */
  display: string;
  tooltip?: ReactNode;
}

/** Horizontal bar list: label + thin bar + value. Identity is carried by the label, not only the color. */
export function BarList({
  data,
  emptyLabel = "No data yet",
  className,
}: {
  data: BarDatum[];
  emptyLabel?: string;
  className?: string;
}) {
  const max = Math.max(0, ...data.map((d) => d.value));
  if (data.length === 0 || max === 0) {
    return <div className="py-8 text-center text-[12.5px] text-steel">{emptyLabel}</div>;
  }
  return (
    <ul className={cn("space-y-1", className)}>
      {data.map((d) => {
        const pct = max > 0 ? (d.value / max) * 100 : 0;
        const row = (
          <li
            tabIndex={0}
            className="group -mx-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 rounded-lg px-2 py-1.5 outline-none transition-colors hover:bg-raised/50 focus-visible:bg-raised/60"
          >
            <div className="flex min-w-0 items-center gap-2">
              {d.icon}
              <span className="truncate text-[12.5px] text-fg">{d.label}</span>
              {d.sub && <span className="truncate text-[11.5px] text-steel">{d.sub}</span>}
            </div>
            <span className="text-right text-[12.5px] font-medium text-fg tabular">{d.display}</span>
            <div className="col-span-2 h-2 overflow-hidden rounded-[4px] bg-raised/70">
              <div
                className="h-full origin-left rounded-[4px] transition-[width] duration-300 ease-out"
                style={{
                  width: `${Math.max(pct, d.value > 0 ? 1.5 : 0)}%`,
                  background: `linear-gradient(90deg, color-mix(in srgb, ${d.color} 70%, transparent), ${d.color})`,
                  boxShadow: `0 0 10px -2px color-mix(in srgb, ${d.color} 55%, transparent)`,
                }}
              />
            </div>
          </li>
        );
        return d.tooltip ? (
          <Tooltip key={d.key} content={d.tooltip} side="top" align="end">
            {row}
          </Tooltip>
        ) : (
          <Fragment key={d.key}>{row}</Fragment>
        );
      })}
    </ul>
  );
}

export interface ShareSegment {
  key: string;
  label: string;
  value: number;
  color: string;
  display: string;
}

/** Single stacked share bar with a 2px surface gap between segments, plus a legend. */
export function ShareBar({ segments }: { segments: ShareSegment[] }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const visible = segments.filter((s) => s.value > 0);
  return (
    <div>
      <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-[4px]">
        {total === 0 ? (
          <div className="h-full w-full bg-raised" />
        ) : (
          visible.map((s) => (
            <Tooltip key={s.key} content={`${s.label}: ${s.display} · ${Math.round((s.value / total) * 100)}%`}>
              <div
                className="h-full first:rounded-l-[4px] last:rounded-r-[4px] transition-[flex-grow] duration-300"
                style={{ flexGrow: s.value, flexBasis: 0, background: s.color }}
              />
            </Tooltip>
          ))
        )}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted">
        {segments.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-[3px]" style={{ background: s.color }} />
            {s.label}
            <span className="text-steel tabular">{total ? `${Math.round((s.value / total) * 100)}%` : "0%"}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
