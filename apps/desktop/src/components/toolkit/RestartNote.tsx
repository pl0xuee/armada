import { Info } from "lucide-react";
import { RESTART_NOTE, restartNote, runningAgents } from "@/lib/toolkit";
import type { Provider } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";

/**
 * Says that a change to tools reaches new agents only. `provider` / `project` narrow whose running
 * agents are counted; `changed` makes it stand out right after the user changed something.
 */
export function RestartNote({
  provider,
  project,
  changed = false,
  className,
}: {
  provider?: Provider;
  project?: string | null;
  changed?: boolean;
  className?: string;
}) {
  const agents = useApp((s) => s.agents);
  const running = runningAgents(Object.values(agents), { provider, project });
  const who = restartNote(running);
  return (
    <p
      role="note"
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-caption leading-[18px]",
        changed && who ? "border-warn/30 bg-warn/8 text-fg" : "border-line bg-card/40 text-muted",
        className,
      )}
    >
      <Info className={cn("mt-[2px] h-3.5 w-3.5 shrink-0", changed && who ? "text-warn" : "text-steel")} />
      <span className="min-w-0">
        {RESTART_NOTE}
        {who && <> {who}</>}
      </span>
    </p>
  );
}
