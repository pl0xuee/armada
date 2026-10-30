import { memo, useState } from "react";
import { planChoices, planResolution, planTitle } from "@shared/planApproval";
import { respondToPermission } from "@/lib/controller";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { useStore } from "@/lib/store";
import type { PermissionItem } from "@/lib/types";
import { DenyReasonSheet } from "../DenyReasonSheet";
import { Icon, Spinner } from "../Icon";
import { Markdown } from "../Markdown";
import { Button } from "../ui";

/** The plan folds to this height until you ask for all of it (a plan can run to pages). */
const FOLDED = "max-h-72";

/**
 * Claude's plan mode asking to leave it (see the desktop's PlanApprovalCard): the plan, the ways to
 * approve it, and "Keep planning", which can carry feedback through the deny-with-reason sheet.
 * Each approval is its own button, named for what it does, so none needs the "always" confirmation.
 */
export const PlanApprovalCard = memo(function PlanApprovalCard({ item, readOnly }: { item: PermissionItem; readOnly: boolean }) {
  const plan = item.plan ?? "";
  const sending = useStore((s) => s.resolving[item.requestId]);
  const now = useNow();
  const [full, setFull] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);

  let body;
  if (item.resolution !== null || sending) {
    const { text, outcome } = item.resolution !== null ? planResolution({ ...item, resolution: item.resolution }) : planResolution({ ...item, resolution: sending ?? null });
    const color = sending && item.resolution === null ? "var(--steel)" : outcome === "approved" ? "var(--ok)" : outcome === "kept_planning" ? "var(--warn)" : "var(--steel)";
    body = (
      <div className="overflow-hidden rounded-2xl border border-line bg-panel edge">
        <button
          type="button"
          aria-expanded={full}
          onClick={() => setFull((v) => !v)}
          className="press flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left"
        >
          <span
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
            style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
          >
            {sending && item.resolution === null ? <Spinner size={14} /> : <Icon name={outcome === "approved" ? "shieldCheck" : "bookText"} size={16} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] text-fg/90">{planTitle(plan)}</span>
            <span className="block text-[12.5px] font-medium" style={{ color }}>
              {sending && item.resolution === null ? `Sending “${text}”…` : text}
            </span>
          </span>
          <Icon name={full ? "chevronDown" : "chevronRight"} size={16} className="shrink-0 text-steel" />
        </button>
        {full && (
          <div className="max-h-96 overflow-y-auto border-t border-line px-4 py-3">
            <Markdown text={plan} />
          </div>
        )}
      </div>
    );
  } else {
    const { approve, keepPlanning } = planChoices(item);
    const respond = (id: string) => void respondToPermission(item.agentId, item.requestId, id);
    body = (
      <section
        aria-label={`Plan ready for approval: ${planTitle(plan)}`}
        className="overflow-hidden rounded-2xl border border-warn/45 bg-card shadow-[0_0_0_1px_color-mix(in_srgb,var(--warn)_14%,transparent),0_16px_40px_-18px_color-mix(in_srgb,var(--warn)_50%,transparent)]"
      >
        <div className="flex items-center gap-2 border-b border-warn/15 bg-warn/[0.06] px-4 py-2.5">
          <Icon name="bookText" size={16} className="text-warn" />
          <span className="text-[12px] font-semibold tracking-wider text-warn uppercase">Plan to approve</span>
          <span className="ml-auto text-[12px] text-steel tabular">{relativeTime(item.ts, now)}</span>
        </div>
        <div className="space-y-3 p-4">
          <div className="relative">
            <div className={cn("overflow-hidden", !full && FOLDED)}>
              <Markdown text={plan} />
            </div>
            {!full && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent" aria-hidden />
            )}
          </div>
          <button
            type="button"
            aria-expanded={full}
            onClick={() => setFull((v) => !v)}
            className="press inline-flex h-9 items-center gap-1 rounded-xl px-1 text-[13.5px] font-medium text-accent"
          >
            <Icon name={full ? "chevronDown" : "chevronRight"} size={16} />
            {full ? "Show less" : "Show the whole plan"}
          </button>
          {readOnly ? (
            <p className="flex items-center gap-2 rounded-xl bg-raised px-3 py-2.5 text-[13px] text-muted">
              <Icon name="eye" size={16} className="shrink-0 text-steel" />
              Waiting for the owner to respond.
            </p>
          ) : (
            <div className="space-y-2">
              {approve.map((c, i) => (
                <Button key={c.option.id} size="lg" variant={i === 0 ? "primary" : "secondary"} className="w-full" onClick={() => respond(c.option.id)}>
                  <span className="truncate">{c.label}</span>
                </Button>
              ))}
              {keepPlanning && (
                <div className="grid grid-cols-2 gap-2">
                  <Button size="md" variant="danger" onClick={() => respond(keepPlanning.id)}>
                    Keep planning
                  </Button>
                  <Button size="md" variant="outline" icon="pencil" onClick={() => setReasonOpen(true)}>
                    With feedback…
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    );
  }

  // The sheet outlives the card's "sending" state, so it can finish and close on its own.
  return (
    <>
      {body}
      {!readOnly && (item.resolution === null || reasonOpen) && <DenyReasonSheet item={reasonOpen ? item : null} onClose={() => setReasonOpen(false)} />}
    </>
  );
});
