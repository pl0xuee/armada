import { CalendarClock, ChartColumn, Columns3, Inbox, LayoutGrid, MessagesSquare, Settings, Users } from "lucide-react";
import { motion } from "motion/react";
import type { ComponentType } from "react";
import { pendingCount, useApp } from "@/store/app";
import { useUi, type View } from "@/store/ui";
import { cn, modKey } from "@/lib/utils";
import { CountBadge } from "./ui/misc";
import { Tooltip } from "./ui/tooltip";

interface RailItem {
  view: View;
  label: string;
  icon: ComponentType<{ className?: string }>;
  shortcut?: string[];
}

const TOP: RailItem[] = [
  { view: "agents", label: "Agents", icon: MessagesSquare },
  { view: "mission", label: "Mission Control", icon: LayoutGrid, shortcut: [modKey, "⇧", "M"] },
  { view: "inbox", label: "Inbox", icon: Inbox, shortcut: [modKey, "I"] },
  { view: "compare", label: "Compare", icon: Columns3 },
  { view: "schedules", label: "Schedules", icon: CalendarClock },
  { view: "usage", label: "Usage", icon: ChartColumn },
  { view: "accounts", label: "Accounts", icon: Users },
];

const BOTTOM: RailItem[] = [{ view: "settings", label: "Settings", icon: Settings, shortcut: [modKey, ","] }];

export function Rail() {
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const pending = useApp((s) => pendingCount(s.agents));
  const working = useApp((s) => Object.values(s.agents).filter((a) => a.status === "working").length);

  const render = (item: RailItem) => {
    const active = view === item.view;
    const Icon = item.icon;
    const badge = item.view === "inbox" ? pending : 0;
    return (
      <Tooltip key={item.view} content={item.label} shortcut={item.shortcut} side="right">
        <button
          type="button"
          aria-label={item.label}
          aria-current={active ? "page" : undefined}
          onClick={() => setView(item.view)}
          className={cn(
            "group relative flex h-10 w-10 items-center justify-center rounded-xl transition-[color,transform] duration-150 active:scale-95",
            active ? "text-fg" : "text-steel hover:text-fg",
          )}
        >
          {active && (
            <motion.span
              layoutId="rail-active"
              transition={{ type: "spring", stiffness: 520, damping: 40 }}
              className="absolute inset-0 rounded-xl border border-line-strong bg-gunmetal/80 edge"
            />
          )}
          {active && (
            <motion.span
              layoutId="rail-bar"
              transition={{ type: "spring", stiffness: 520, damping: 40 }}
              className="absolute -left-[9px] top-2.5 h-5 w-[3px] rounded-r-full bg-accent shadow-[0_0_10px_var(--accent)]"
            />
          )}
          <span className="absolute inset-0 rounded-xl bg-raised opacity-0 transition-opacity group-hover:opacity-60" />
          <Icon className="relative z-10 h-[18px] w-[18px]" />
          {badge > 0 && <CountBadge count={badge} className="absolute -right-1 -top-1 z-20" />}
          {item.view === "mission" && working > 0 && (
            <span className="absolute right-1.5 top-1.5 z-20 h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_6px_var(--accent)] animate-breathe" />
          )}
        </button>
      </Tooltip>
    );
  };

  return (
    <nav
      aria-label="Primary"
      className="texture flex w-[56px] shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2.5"
    >
      {TOP.map(render)}
      <div className="flex-1" />
      {BOTTOM.map(render)}
    </nav>
  );
}
