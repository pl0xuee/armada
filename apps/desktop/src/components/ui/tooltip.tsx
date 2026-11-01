import * as T from "@radix-ui/react-tooltip";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Kbd } from "./kbd";

export const TooltipProvider = T.Provider;

/** Focus from the keyboard opens a tooltip this late, so tabbing through controls doesn't flash one per stop. */
const KEYBOARD_DELAY_MS = 450;

/** Hides the tooltip showing now; only one is ever open, so a fast Tab never piles them up. */
let hideShowing: ((instant: boolean) => void) | null = null;

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
  const [open, setOpen] = useState(false);
  // The previous tooltip leaves without its exit animation so it can't overlap the next one's entrance.
  const [instant, setInstant] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hide = useCallback((now = false) => {
    clearTimeout(timer.current);
    if (hideShowing === hide) hideShowing = null;
    setInstant(now);
    setOpen(false);
  }, []);
  const show = useCallback(() => {
    if (hideShowing && hideShowing !== hide) hideShowing(true);
    hideShowing = hide;
    setInstant(false);
    setOpen(true);
  }, [hide]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (hideShowing === hide) hideShowing = null;
    },
    [hide],
  );
  const onOpenChange = (next: boolean) => {
    clearTimeout(timer.current);
    if (!next) hide();
    else if (triggerRef.current?.matches(":focus-visible")) timer.current = setTimeout(show, KEYBOARD_DELAY_MS);
    else show();
  };

  return (
    <T.Root open={open} onOpenChange={onOpenChange} delayDuration={delay}>
      <T.Trigger ref={triggerRef} asChild>
        {children}
      </T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          align={align}
          sideOffset={6}
          className={cn(
            "z-[80] flex items-center gap-2 rounded-lg border border-line-strong bg-raised px-2 py-1 text-xs text-fg shadow-xl shadow-black/40 edge",
            "anim-pop",
            instant && "data-[state=closed]:!animate-none",
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
