import { ChevronRight } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A quiet "More options" row at the bottom of a SettingGroup; the extra rows appear below it
 * (they are siblings, so the group's dividers still apply).
 */
export function MoreRows({ label = "More options", children }: { label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-4 py-2.5 text-left text-small text-muted transition-colors hover:bg-raised/40 hover:text-fg"
      >
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform duration-150", open && "rotate-90")} />
        {open ? "Fewer options" : label}
      </button>
      <div id={id} hidden={!open} className="contents">
        {open && children}
      </div>
    </>
  );
}
