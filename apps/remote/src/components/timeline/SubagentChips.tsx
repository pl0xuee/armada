import { cn } from "@/lib/cn";
import type { SubagentChip } from "@/lib/subagents";

/** Model / effort chips of a sub-agent; a value it inherits from the main agent is drawn muted and italic. */
export function SubagentChips({ chips, className }: { chips: readonly SubagentChip[]; className?: string }) {
  if (!chips.length) return null;
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}>
      {chips.map((c) => (
        <span
          key={c.key}
          className={cn(
            "max-w-full truncate rounded-md border px-1.5 py-px text-[11px] leading-4",
            c.inherited ? "border-line/70 text-steel italic" : "border-line bg-card text-muted",
          )}
        >
          {c.text}
        </span>
      ))}
    </span>
  );
}
