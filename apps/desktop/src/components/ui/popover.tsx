import * as P from "@radix-ui/react-popover";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverClose = P.Close;

export function PopoverContent({
  children,
  className,
  align = "center",
  side = "bottom",
}: {
  children: ReactNode;
  className?: string;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <P.Portal>
      <P.Content
        align={align}
        side={side}
        sideOffset={8}
        collisionPadding={8}
        className={cn(
          "anim-pop z-[70] w-72 max-w-[calc(100vw-16px)] max-h-[calc(var(--radix-popover-content-available-height)-8px)] overflow-y-auto rounded-xl border border-line-strong bg-raised/95 p-3 text-[13px] shadow-[0_16px_48px_-8px_rgba(0,0,0,0.55)] backdrop-blur-xl edge focus:outline-none",
          className,
        )}
      >
        {children}
      </P.Content>
    </P.Portal>
  );
}
