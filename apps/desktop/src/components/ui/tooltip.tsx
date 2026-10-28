import * as T from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Kbd } from "./kbd";

export const TooltipProvider = T.Provider;

export function Tooltip({
  content,
  shortcut,
  side = "top",
  align = "center",
  children,
  className,
  delay,
}: {
  content: ReactNode;
  shortcut?: string[];
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <T.Root delayDuration={delay}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          align={align}
          sideOffset={6}
          className={cn(
            "z-[80] flex items-center gap-2 rounded-lg border border-line-strong bg-raised px-2 py-1 text-xs text-fg shadow-xl shadow-black/40 edge",
            "anim-pop",
            className,
          )}
        >
          {content}
          {shortcut && (
            <span className="flex gap-0.5">
              {shortcut.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
          )}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
