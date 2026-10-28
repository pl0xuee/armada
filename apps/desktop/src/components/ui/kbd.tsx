import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-line-strong bg-card px-1 font-sans text-[10.5px] font-medium leading-none text-muted shadow-[inset_0_-1px_0_var(--border)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
