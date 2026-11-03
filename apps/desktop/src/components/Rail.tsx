import { CalendarClock, ChartColumn, Columns3, LayoutGrid, MessagesSquare, Settings, Users } from "lucide-react";
import { m } from "motion/react";
import type { ComponentType } from "react";
import { useTriageCount } from "./triage/useTriage";
import { useApp } from "@/store/app";
import { useBackgroundIds } from "@/store/background";
import { useUi, type View } from "@/store/ui";
import { cn, modKey } from "@/lib/utils";
import { CountBadge } from "./ui/misc";
import { Tooltip } from "./ui/tooltip";

interface RailItem {
  view: View;
  label: string;
  /** The name under the icon (the full label is the button's name and tooltip). */
  short?: string;
  icon: ComponentType<{ className?: string }>;
  shortcut?: string[];
}

const TOP: RailItem[] = [
  { view: "agents", label: "Projects", icon: MessagesSquare },
  { view: "mission", label: "Mission Control", short: "Mission", icon: LayoutGrid, shortcut: [modKey, "⇧", "M"] },
  { view: "compare", label: "Compare", icon: Columns3 },
  { view: "schedules", label: "Schedules", icon: CalendarClock },
  { view: "usage", label: "Usage", icon: ChartColumn },
  { view: "accounts", label: "Accounts", icon: Users },
];

const BOTTOM: RailItem[] = [{ view: "settings", label: "Settings", icon: Settings, shortcut: [modKey, ","] }];

export function Rail() {
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const background = useBackgroundIds();
  const working = useApp(
    (s) =>
      Object.values(s.agents).filter((a) => a.status === "working" || (a.status === "idle" && background.has(a.id)))
        .length,
  );
  // The same count as the Needs you tab and the window title.
  const needs = useTriageCount();

  const render = (item: RailItem) => {
    const active = view === item.view;
    const Icon = item.icon;
    const mission = item.view === "mission";
    const badge = mission ? needs : 0;
    // Screen readers get the counts in the name (badges are visual only).
    const waiting = mission && needs > 0 ? `${needs} need${needs === 1 ? "s" : ""} you` : null;
    const label = mission
      ? [item.label, waiting, working > 0 ? `${working} working` : null].filter(Boolean).join(", ")
      : item.label;
    return (
      <Tooltip
        key={item.view}
        content={waiting ? `${item.label} · ${waiting}` : item.label}
        shortcut={item.shortcut}
        side="right"
      >
        <button
          type="button"
          aria-label={label}
          aria-current={active ? "page" : undefined}
          onClick={() => setView(item.view)}
          className={cn(
            "group relative flex w-[60px] flex-col items-center gap-[3px] rounded-xl pb-1 pt-1 transition-[color,transform] duration-150 active:scale-95",
            active ? "text-fg" : "text-steel hover:text-fg",
          )}
        >
          {active && (
            <m.span
              layoutId="rail-bar"
              transition={{ type: "spring", stiffness: 520, damping: 40 }}
              className="absolute -left-1 top-2 h-5 w-[3px] rounded-r-full bg-accent shadow-[0_0_10px_var(--accent)]"
            />
          )}
          <span className="relative flex h-8 w-11 items-center justify-center rounded-[10px]">
            {active && (
              <m.span
                layoutId="rail-active"
                transition={{ type: "spring", stiffness: 520, damping: 40 }}
                className="absolute inset-0 rounded-[10px] border border-line-strong bg-gunmetal/80 edge"
              />
            )}
            <span className="absolute inset-0 rounded-[10px] bg-raised opacity-0 transition-opacity group-hover:opacity-60" />
            <Icon className="relative z-10 h-[18px] w-[18px]" />
            {badge > 0 && (
              <span aria-hidden className="absolute -right-1.5 -top-1.5 z-20">
                <CountBadge count={badge} />
              </span>
            )}
            {mission && working > 0 && (
              <span
                aria-hidden
                className="absolute right-1 top-1 z-20 h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_6px_var(--accent)] animate-breathe"
              />
            )}
          </span>
          <span
            aria-hidden
            className={cn(
              "max-w-full truncate px-0.5 text-[10.5px] leading-[13px] tracking-[-0.005em] [@media(max-height:579px)]:hidden",
              active ? "font-semibold" : "font-medium",
            )}
          >
            {item.short ?? item.label}
          </span>
        </button>
      </Tooltip>
    );
  };

  return (
    <nav
      aria-label="Primary"
      className="texture flex w-[68px] shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2"
    >
      {TOP.map(render)}
      <div className="flex-1" />
      {BOTTOM.map(render)}
    </nav>
  );
}
