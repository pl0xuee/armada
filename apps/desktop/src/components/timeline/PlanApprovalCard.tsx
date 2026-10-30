import { ChevronRight, ListChecks, MessageSquareX } from "lucide-react";
import { m } from "motion/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useIdentity } from "@/hooks/useIdentity";
import { respondPermission } from "@/lib/actions";
import { api } from "@/lib/api";
import { planChoices, planResolution, planTitle } from "@/lib/planApproval";
import type { Agent, PermissionOption, TimelineItem } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { usePermissionUi } from "@/store/permissionUi";
import { Markdown } from "../Markdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Spinner } from "../ui/misc";
import { permissionKeyOptions } from "./usePermissionKeys";

type Item = Extract<TimelineItem, { kind: "permission" }>;

/**
 * Claude's plan mode asking to leave it: the plan as markdown, with the ways to approve it
 * (the adapter's own options, worded for what they do) and "Keep planning", which can carry
 * feedback: the plan is declined, then your note goes out as the next message.
 */
export const PlanApprovalCard = memo(function PlanApprovalCard({
  item,
  agent,
  keyboard,
  reasonOpen,
  onReasonOpenChange,
}: {
  item: Item;
  agent: Agent;
  /** This request answers to A / D (the latest pending one in the visible agent). */
  keyboard?: boolean;
  /** Feedback editor, controlled by the timeline (Shift+D). */
  reasonOpen?: boolean;
  onReasonOpenChange?: (open: boolean) => void;
}) {
  const plan = item.plan ?? "";
  const pending = item.resolution === null;
  const [busy, setBusy] = useState<string | null>(null);
  const [localReason, setLocalReason] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const feedback = usePermissionUi((s) => s.reasonDraft[item.requestId] ?? "");
  const setFeedback = (text: string) => usePermissionUi.getState().setReasonDraft(item.requestId, text);
  const identity = useIdentity(agent.provider, agent.customAgentId);
  const { approve, keepPlanning } = useMemo(() => planChoices(item), [item]);
  const keyed = useMemo(() => permissionKeyOptions(item), [item]);
  const showReason = reasonOpen ?? localReason;
  const setShowReason = onReasonOpenChange ?? setLocalReason;

  // Keyboard approvals only act while this card is on screen.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = cardRef.current;
    if (!el || !keyboard || !pending) return;
    const id = item.requestId;
    const io = new IntersectionObserver(
      ([entry]) => usePermissionUi.getState().setVisible(id, entry.isIntersecting && entry.intersectionRatio > 0.25),
      { threshold: [0, 0.25, 0.5] },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      usePermissionUi.getState().setVisible(id, false);
    };
  }, [keyboard, pending, item.requestId]);
  useEffect(() => {
    if (!pending) usePermissionUi.getState().clear(item.requestId);
  }, [pending, item.requestId]);

  if (!pending) {
    const { text, outcome } = planResolution(item);
    return (
      <div className="rounded-xl border border-line bg-card/50">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="flex h-9 w-full items-center gap-2 rounded-xl px-2.5 text-left text-[12.5px] hover:bg-raised/50"
        >
          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-steel transition-transform", expanded && "rotate-90")} />
          <ListChecks className="h-3.5 w-3.5 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate text-muted">{planTitle(plan)}</span>
          <span
            className={cn(
              "shrink-0 text-[11.5px] font-medium",
              outcome === "approved" ? "text-ok" : outcome === "kept_planning" ? "text-warn" : "text-steel",
            )}
          >
            {text}
          </span>
        </button>
        {expanded && (
          <div className="selectable max-h-[420px] overflow-y-auto border-t border-line px-4 py-3">
            <Markdown text={plan} />
          </div>
        )}
      </div>
    );
  }

  const answer = async (o: PermissionOption) => {
    if (busy) return;
    setBusy(o.id);
    await respondPermission(agent.id, item, o);
    setBusy(null);
  };

  const keepPlanningWithFeedback = async () => {
    const text = feedback.trim();
    if (!keepPlanning || !text || busy) return;
    setBusy(keepPlanning.id);
    // If the decline didn't go through, don't send the note as if it had.
    if (!(await respondPermission(agent.id, item, keepPlanning))) {
      setBusy(null);
      return;
    }
    try {
      await api.sendPrompt(agent.id, text);
      setFeedback("");
      setShowReason(false);
    } catch (e) {
      toast.error("Kept planning, but couldn't send your feedback", { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      ref={cardRef}
      role="group"
      tabIndex={keyboard ? 0 : undefined}
      data-permission-request={item.requestId}
      aria-label={`Plan ready for approval: ${planTitle(plan)}${keyboard ? ". Enter approves and reviews each edit." : ""}`}
      className="relative overflow-hidden rounded-2xl border border-warn/40 bg-gradient-to-b from-warn/[0.09] to-card shadow-[0_0_0_1px_color-mix(in_srgb,var(--warn)_10%,transparent),0_12px_40px_-16px_color-mix(in_srgb,var(--warn)_45%,transparent)] edge"
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-warn/70 to-transparent" />
      <div className="flex items-start gap-3 px-4 pb-3 pt-3.5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-warn/40 bg-warn/15 text-warn">
          <ListChecks className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-warn">
            {identity.short} has a plan for your approval
          </div>
          <div className="mt-0.5 break-words text-[14px] font-medium text-fg">Review the plan, then choose how it goes ahead</div>
        </div>
      </div>
      <div className="selectable mx-4 mb-3 max-h-[min(460px,55vh)] overflow-y-auto rounded-xl border border-line bg-base/40 px-4 py-3">
        <Markdown text={plan} />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-warn/15 bg-base/30 px-4 py-3">
        {approve.map((c, i) => (
          <Button
            key={c.option.id}
            size="sm"
            title={c.hint}
            disabled={busy !== null}
            variant={i === 0 ? "warn" : "secondary"}
            onClick={() => void answer(c.option)}
            aria-keyshortcuts={keyboard && keyed.allow?.id === c.option.id ? "A Y" : undefined}
          >
            {busy === c.option.id ? <Spinner className="h-3.5 w-3.5 text-current" /> : null}
            {c.label}
            {keyboard && keyed.allow?.id === c.option.id && (
              <Kbd className="ml-0.5 border-current/25 bg-transparent text-current opacity-75">A</Kbd>
            )}
          </Button>
        ))}
        {keepPlanning && (
          <Button
            size="sm"
            variant="danger"
            disabled={busy !== null}
            onClick={() => void answer(keepPlanning)}
            aria-keyshortcuts={keyboard ? "D N" : undefined}
            className="sm:ml-auto"
          >
            {busy === keepPlanning.id ? <Spinner className="h-3.5 w-3.5 text-current" /> : null}
            Keep planning
            {keyboard && <Kbd className="ml-0.5 border-current/25 bg-transparent text-current opacity-75">D</Kbd>}
          </Button>
        )}
        {keepPlanning && !showReason && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => setShowReason(true)}
            aria-keyshortcuts={keyboard ? "Shift+D Shift+N" : undefined}
          >
            <MessageSquareX />
            Keep planning with feedback…
            {keyboard && <Kbd className="ml-0.5">⇧D</Kbd>}
          </Button>
        )}
      </div>
      {showReason && keepPlanning && (
        <form
          className="border-t border-warn/15 bg-base/40 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            void keepPlanningWithFeedback();
          }}
        >
          <label htmlFor={`feedback-${item.id}`} className="mb-1.5 block text-[12px] font-medium text-muted">
            What should {identity.short} change in the plan?
          </label>
          <Textarea
            id={`feedback-${item.id}`}
            autoFocus
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                void keepPlanningWithFeedback();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setShowReason(false);
              }
            }}
            placeholder="e.g. Skip the refactor for now and start with the failing test."
            className="min-h-16"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <span className="mr-auto text-[11px] text-steel">Sends the plan back, then your note as the next message.</span>
            <Button size="sm" variant="ghost" type="button" onClick={() => setShowReason(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="warn" type="submit" disabled={!feedback.trim() || busy !== null}>
              {busy === keepPlanning.id && <Spinner className="h-3.5 w-3.5 text-current" />}
              Keep planning & send
            </Button>
          </div>
        </form>
      )}
    </m.div>
  );
});
