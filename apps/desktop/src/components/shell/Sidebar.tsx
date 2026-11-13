import { m } from "motion/react";
import { AgentList } from "@/components/agent/AgentList";
import { RAIL_BOTTOM, RAIL_TOP, Rail, type RailItem } from "@/components/Rail";
import { useTriageCount } from "@/components/triage/useTriage";
import { CountBadge } from "@/components/ui/misc";
import { Tooltip } from "@/components/ui/tooltip";
import { useAgentListLayout } from "@/hooks/useAgentListLayout";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";

/**
 * Minimal look: what sits left of the sheet on every screen. The agents (by activity or by project) with the
 * other screens as icons under them; the icon rail instead while the list is hidden or the window is narrow.
 */
export function SideNav() {
  const list = useAgentListLayout();
  if (!list.docked || !list.open) return <Rail />;
  return (
    <div className="flex w-[clamp(272px,24vw,300px)] shrink-0 flex-col">
      <div className="min-h-0 flex-1">
        <AgentList variant="docked" />
      </div>
      <ScreenNav />
    </div>
  );
}

const ITEMS: RailItem[] = [...RAIL_TOP, ...RAIL_BOTTOM];

/** The rail's screens as one row of icons. */
function ScreenNav() {
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  // The same count as the Needs you tab and the window title.
  const needs = useTriageCount();
  return (
    <nav aria-label="Primary" className="flex shrink-0 items-center justify-between px-3 pb-2.5 pt-1.5">
      {ITEMS.map((item) => {
        const active = view === item.view;
        const Icon = item.icon;
        const waiting = item.view === "mission" && needs > 0 ? `${needs} need${needs === 1 ? "s" : ""} you` : null;
        // Here the first item is the way back to the start screen (the agents are listed above).
        const name = item.view === "agents" ? "Home" : item.label;
        return (
          <Tooltip
            key={item.view}
            content={waiting ? `${name} · ${waiting}` : name}
            shortcut={item.shortcut}
            side="top"
          >
            <button
              type="button"
              aria-label={waiting ? `${name}, ${waiting}` : name}
              aria-current={active ? "page" : undefined}
              onClick={() => setView(item.view)}
              className={cn(
                "relative flex h-8 w-9 items-center justify-center rounded-[10px] transition-[color,background-color,transform] duration-150 active:scale-95",
                active ? "text-fg" : "text-steel hover:bg-raised/60 hover:text-fg",
              )}
            >
              {/* Slides to the screen you open (a transform, so it stays smooth while agents stream). */}
              {active && (
                <m.span
                  layoutId="screen-nav-active"
                  transition={{ type: "spring", stiffness: 520, damping: 40 }}
                  className="absolute inset-0 rounded-[10px] m-raised-flat"
                />
              )}
              <Icon className="relative h-[17px] w-[17px]" />
              {waiting && (
                <span aria-hidden className="absolute -right-1 -top-1">
                  <CountBadge count={needs} />
                </span>
              )}
            </button>
          </Tooltip>
        );
      })}
    </nav>
  );
}
