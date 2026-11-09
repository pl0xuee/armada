import { ArrowDown, ArrowUp, ChevronRight, Ellipsis, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { SECTION_NAME_MAX } from "@/lib/projectLayout";
import type { ProjectSection } from "@/lib/types";
import { cn, isMac } from "@/lib/utils";
import { Button } from "../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/menu";
import { Tooltip } from "../ui/tooltip";

export const moveKeys = { up: isMac ? "⌥↑" : "Alt+↑", down: isMac ? "⌥↓" : "Alt+↓" };

interface Props {
  section: ProjectSection;
  /** Projects shown in it. */
  count: number;
  needs: number;
  working: number;
  collapsed: boolean;
  renaming: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onToggle: () => void;
  onPointerDown: (e: PointerEvent) => void;
  onStartRename: () => void;
  /** The new name, or null when renaming was cancelled. */
  onRenamed: (name: string | null) => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
}

/** A named group in the project list: folds, renames in place, drags, and has a menu (also on right-click). */
export function ProjectSectionHeader(p: Props) {
  // Rename from a menu: keep focus in the name field instead of returning it to the menu's button.
  const keepFocus = useRef(false);
  const startRename = () => {
    keepFocus.current = true;
    p.onStartRename();
  };
  const closeAutoFocus = (e: Event) => {
    if (keepFocus.current) e.preventDefault();
    keepFocus.current = false;
  };
  const items: { label: string; icon: ReactNode; onSelect: () => void; disabled?: boolean; shortcut?: string }[] = [
    { label: "Rename", icon: <Pencil />, onSelect: startRename, shortcut: "F2" },
    {
      label: "Move up",
      icon: <ArrowUp />,
      onSelect: () => p.onMove(-1),
      disabled: !p.canMoveUp,
      shortcut: moveKeys.up,
    },
    {
      label: "Move down",
      icon: <ArrowDown />,
      onSelect: () => p.onMove(1),
      disabled: !p.canMoveDown,
      shortcut: moveKeys.down,
    },
  ];
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "F2") {
      e.preventDefault();
      p.onStartRename();
    } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      p.onMove(e.key === "ArrowUp" ? -1 : 1);
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={p.renaming}>
        <div
          data-section-header={p.section.id}
          data-collapsed={p.collapsed}
          className="group/section relative flex h-8 items-center gap-0.5 rounded-t-xl px-0.5"
        >
          {p.renaming ? (
            <SectionNameInput initial={p.section.name} onDone={p.onRenamed} />
          ) : (
            <button
              type="button"
              onClick={p.onToggle}
              onPointerDown={p.onPointerDown}
              onDoubleClick={p.onStartRename}
              onKeyDown={onKeyDown}
              aria-expanded={!p.collapsed}
              title={p.section.name}
              className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 eyebrow text-muted outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <ChevronRight
                className={cn(
                  "h-3 w-3 shrink-0 text-steel transition-transform duration-150",
                  !p.collapsed && "rotate-90",
                )}
              />
              <span className="truncate">{p.section.name}</span>
              <span className="shrink-0 rounded-full bg-raised px-1.5 text-micro font-semibold leading-4 tracking-normal text-muted tabular">
                {p.count}
              </span>
              {/* Folded, it still says when something inside needs you. */}
              {p.collapsed && p.needs > 0 && (
                <span
                  className="flex shrink-0 items-center gap-1 rounded-full bg-warn/20 px-1.5 py-px text-micro font-semibold normal-case tracking-normal text-warn ring-1 ring-warn/40 tabular"
                  title={`${p.needs} need${p.needs === 1 ? "s" : ""} you`}
                >
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-warn" />
                  {p.needs}
                  <span className="sr-only">need{p.needs === 1 ? "s" : ""} you</span>
                </span>
              )}
              {p.collapsed && p.needs === 0 && p.working > 0 && (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent animate-breathe"
                  aria-label={`${p.working} working`}
                />
              )}
            </button>
          )}
          {!p.renaming && (
            <DropdownMenu>
              <Tooltip content="Section options">
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`${p.section.name} section options`}
                    className="shrink-0 text-muted opacity-0 transition-opacity focus-visible:opacity-100 group-hover/section:opacity-100 data-[state=open]:opacity-100"
                  >
                    <Ellipsis className="!h-3.5 !w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
              </Tooltip>
              <DropdownMenuContent align="end" className="min-w-[180px]" onCloseAutoFocus={closeAutoFocus}>
                {items.map((it) => (
                  <DropdownMenuItem key={it.label} onSelect={it.onSelect} disabled={it.disabled} shortcut={it.shortcut}>
                    {it.icon} {it.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem danger onSelect={p.onDelete}>
                  <Trash2 /> Delete section
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={closeAutoFocus}>
        {items.map((it) => (
          <ContextMenuItem key={it.label} onSelect={it.onSelect} disabled={it.disabled} shortcut={it.shortcut}>
            {it.icon} {it.label}
          </ContextMenuItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem danger onSelect={p.onDelete}>
          <Trash2 /> Delete section
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function SectionNameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  // A blur before the field ever had focus is the closing menu, not the user leaving it.
  const focused = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  useEffect(() => {
    // After a menu closes and returns focus, take it.
    const t = setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, []);
  return (
    <input
      ref={ref}
      defaultValue={initial}
      maxLength={SECTION_NAME_MAX}
      aria-label="Section name"
      spellCheck={false}
      onFocus={() => (focused.current = true)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") {
          e.stopPropagation();
          finish(null);
        }
      }}
      onBlur={(e) => focused.current && finish(e.currentTarget.value)}
      className="h-7 min-w-0 flex-1 rounded-md border border-accent/50 bg-base px-2 text-caption font-semibold text-fg outline-none ring-3 ring-accent/10"
    />
  );
}
