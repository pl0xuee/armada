// Shared styling for dropdown + context menus.
import * as CM from "@radix-ui/react-context-menu";
import * as DM from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const contentClass =
  "anim-pop z-[70] min-w-[200px] overflow-hidden rounded-xl border border-line-strong bg-raised/95 p-1 text-[13px] text-fg shadow-[0_16px_48px_-8px_rgba(0,0,0,0.55)] backdrop-blur-xl edge";
const itemClass =
  "relative flex h-8 cursor-default select-none items-center gap-2 rounded-lg px-2 outline-none transition-colors data-[highlighted]:bg-gunmetal data-[disabled]:opacity-40 [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0 [&_svg]:text-steel data-[highlighted]:[&_svg]:text-fg";
const dangerClass = "text-err data-[highlighted]:bg-err/15 [&_svg]:!text-err";

export const DropdownMenu = DM.Root;
export const DropdownMenuTrigger = DM.Trigger;
export const DropdownMenuSub = DM.Sub;

export function DropdownMenuContent({
  children,
  className,
  align = "start",
  side,
  sideOffset = 6,
}: {
  children: ReactNode;
  className?: string;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
}) {
  return (
    <DM.Portal>
      <DM.Content align={align} side={side} sideOffset={sideOffset} className={cn(contentClass, className)}>
        {children}
      </DM.Content>
    </DM.Portal>
  );
}

export function DropdownMenuItem({
  children,
  onSelect,
  danger,
  disabled,
  shortcut,
  className,
}: {
  children: ReactNode;
  onSelect?: (e: Event) => void;
  danger?: boolean;
  disabled?: boolean;
  shortcut?: string;
  className?: string;
}) {
  return (
    <DM.Item onSelect={onSelect} disabled={disabled} className={cn(itemClass, danger && dangerClass, className)}>
      {children}
      {shortcut && <span className="ml-auto pl-4 text-[11px] text-steel">{shortcut}</span>}
    </DM.Item>
  );
}

export function DropdownMenuCheckItem({
  children,
  checked,
  onSelect,
  description,
}: {
  children: ReactNode;
  checked: boolean;
  onSelect: () => void;
  description?: string | null;
}) {
  return (
    <DM.Item onSelect={onSelect} className={cn(itemClass, "h-auto min-h-8 py-1.5")}>
      <span className="flex w-4 justify-center">{checked && <Check className="!text-accent" />}</span>
      <span className="flex min-w-0 flex-col">
        <span>{children}</span>
        {description && <span className="text-[11.5px] text-steel">{description}</span>}
      </span>
    </DM.Item>
  );
}

export function DropdownMenuLabel({ children }: { children: ReactNode }) {
  return (
    <DM.Label className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-steel">
      {children}
    </DM.Label>
  );
}

export function DropdownMenuSeparator() {
  return <DM.Separator className="-mx-1 my-1 h-px bg-line" />;
}

export function DropdownMenuSubTrigger({ children }: { children: ReactNode }) {
  return (
    <DM.SubTrigger className={cn(itemClass, "data-[state=open]:bg-gunmetal")}>
      {children}
      <ChevronRight className="ml-auto" />
    </DM.SubTrigger>
  );
}

export function DropdownMenuSubContent({ children }: { children: ReactNode }) {
  return (
    <DM.Portal>
      <DM.SubContent sideOffset={6} className={contentClass}>
        {children}
      </DM.SubContent>
    </DM.Portal>
  );
}

// ---------------------------------------------------------------- context menu

export const ContextMenu = CM.Root;
export const ContextMenuTrigger = CM.Trigger;
export const ContextMenuSub = CM.Sub;

export function ContextMenuContent({
  children,
  onCloseAutoFocus,
}: {
  children: ReactNode;
  /** e.g. preventDefault so an inline editor opened from the menu keeps focus. */
  onCloseAutoFocus?: (e: Event) => void;
}) {
  return (
    <CM.Portal>
      <CM.Content className={contentClass} onCloseAutoFocus={onCloseAutoFocus}>
        {children}
      </CM.Content>
    </CM.Portal>
  );
}

export function ContextMenuItem({
  children,
  onSelect,
  danger,
  disabled,
  shortcut,
}: {
  children: ReactNode;
  onSelect?: (e: Event) => void;
  danger?: boolean;
  disabled?: boolean;
  shortcut?: string;
}) {
  return (
    <CM.Item onSelect={onSelect} disabled={disabled} className={cn(itemClass, danger && dangerClass)}>
      {children}
      {shortcut && <span className="ml-auto pl-4 text-[11px] text-steel">{shortcut}</span>}
    </CM.Item>
  );
}

export function ContextMenuSeparator() {
  return <CM.Separator className="-mx-1 my-1 h-px bg-line" />;
}

export function ContextMenuSubTrigger({ children }: { children: ReactNode }) {
  return (
    <CM.SubTrigger className={cn(itemClass, "data-[state=open]:bg-gunmetal")}>
      {children}
      <ChevronRight className="ml-auto" />
    </CM.SubTrigger>
  );
}

export function ContextMenuSubContent({ children }: { children: ReactNode }) {
  return (
    <CM.Portal>
      <CM.SubContent sideOffset={6} className={contentClass}>
        {children}
      </CM.SubContent>
    </CM.Portal>
  );
}
