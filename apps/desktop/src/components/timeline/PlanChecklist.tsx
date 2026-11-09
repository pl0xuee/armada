import type { TimelineItem } from "@/lib/types";
import { cn } from "@/lib/utils";

// Its own file so the pinned plan and the inspector do not pull in the whole timeline (markdown, diffs).
export function PlanChecklist({
  entries,
  dense,
  still,
}: {
  entries: Extract<TimelineItem, { kind: "plan" }>["entries"];
  dense?: boolean;
  /** No pulsing dot on the current step (the plan is pinned above the composer, where it shows progress). */
  still?: boolean;
}) {
  return (
    <ul className={cn("space-y-1", dense && "space-y-0.5")}>
      {entries.map((e, i) => (
        <li key={i} className="flex items-start gap-2.5 text-small leading-snug">
          <span
            className={cn(
              "mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
              e.status === "completed" && "border-ok/50 bg-ok/15 text-ok",
              e.status === "in_progress" && "border-accent/60 text-accent",
              e.status === "pending" && "border-line-strong",
            )}
          >
            {e.status === "completed" && (
              <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden>
                <path
                  d="M2.5 6.2 5 8.5l4.5-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
            {e.status === "in_progress" && (
              <span className={cn("h-1.5 w-1.5 rounded-full bg-accent", !still && "animate-breathe")} />
            )}
          </span>
          <span
            className={cn(
              e.status === "completed" && "text-steel line-through decoration-line-strong",
              e.status === "in_progress" && "font-medium text-fg",
              e.status === "pending" && "text-muted",
            )}
          >
            {e.content}
          </span>
          {e.priority === "high" && e.status !== "completed" && (
            <span className="ml-auto mt-px shrink-0 rounded px-1 eyebrow text-warn">high</span>
          )}
        </li>
      ))}
    </ul>
  );
}
