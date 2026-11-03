import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { NeedsYouDetail } from "@/components/mission/NeedsYouDetail";
import { ResumesAt } from "@/components/agent/ResumesAt";
import { ProviderGlyph } from "@/components/ProviderGlyph";
import { RelTime } from "@/components/RelTime";
import {
  REASON_TONE,
  reasonLabel,
  useQuestionAgents,
  useTriageQueue,
  useTriageStore,
  type TriageEntry,
} from "@/components/triage/useTriage";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip } from "@/components/ui/tooltip";
import { RecoveryActions, needsRecovery } from "@/components/mission/RecoveryActions";
import { archiveAgent, findOption, respondPermission, attempt } from "@/lib/actions";
import { api } from "@/lib/api";
import { approvalActionFor, createArm, shouldIgnoreApprovalKey } from "@/lib/approvalKeys";
import type { NeedsReason } from "@/lib/agents";
import { backgroundActive } from "@/lib/background";
import { useBackground } from "@/store/background";
import type { Agent } from "@/lib/types";
import { cn, isEditableTarget, modKey } from "@/lib/utils";
import { collectPending, useApp } from "@/store/app";
import { useUi } from "@/store/ui";

/** Mission Control's "Needs you" tab: the agents waiting on you, most urgent first, with the answer inline. */
export function NeedsYouPane() {
  const queue = useTriageQueue();
  const selectedId = useTriageStore((s) => s.selectedId);
  const select = useTriageStore((s) => s.select);
  const lastIndex = useRef(0);
  const questionAgents = useQuestionAgents();

  // Keep a selection: the chosen agent while it's queued, else whatever took its place.
  const found = queue.findIndex((e) => e.agent.id === selectedId);
  const index = found >= 0 ? found : Math.min(lastIndex.current, Math.max(0, queue.length - 1));
  const current: TriageEntry | undefined = queue[index];
  useEffect(() => {
    lastIndex.current = index;
    if (current && current.agent.id !== selectedId) select(current.agent.id);
  }, [current, index, selectedId, select]);

  // Timelines for everything queued (permissions, last messages, errors).
  const ids = queue.map((e) => e.agent.id).join(",");
  useEffect(() => {
    if (!ids) return;
    for (const id of ids.split(",")) void useApp.getState().ensureItems(id);
  }, [ids]);

  const busy = useRef(false);
  const run = async (fn: () => Promise<unknown>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      await fn();
    } finally {
      busy.current = false;
    }
  };

  const markDone = (e: TriageEntry) =>
    run(async () => {
      // An approval or question is still blocking; "Done" would just hide it.
      if (e.reason === "permission") {
        if (questionAgents.has(e.agent.id)) {
          toast("Answer the question first", {
            description: "Answer or skip it here, or open the agent to do it there.",
          });
        } else {
          toast("Answer the request first", {
            description: "Approve or deny it (A / D), or open the agent to decide there.",
          });
        }
        return;
      }
      if (e.reason === "budget") {
        toast("Choose how to go on", { description: "Raise the limit, continue once, or stop." });
        return;
      }
      await attempt("Couldn't mark it done", () => api.acknowledgeAgent(e.agent.id));
    });
  const archive = (e: TriageEntry) =>
    run(async () => {
      await archiveAgent(e.agent, true);
    });
  const step = (d: number) => {
    if (queue.length === 0) return;
    select(queue[(index + d + queue.length) % queue.length].agent.id);
  };

  // "Always allow" is irreversible: Shift+A arms, a second Shift+A confirms.
  const [alwaysArmed, setAlwaysArmed] = useState(false);
  const arm = useRef(createArm());
  useEffect(() => {
    arm.current.reset();
    setAlwaysArmed(false);
  }, [current?.agent.id]);

  const answer = (action: "allow_once" | "allow_always" | "deny") => {
    if (!current || current.reason !== "permission") return false;
    const item = collectPending(useApp.getState()).find((p) => p.agent.id === current.agent.id)?.item;
    const opt =
      item &&
      findOption(
        item,
        action === "allow_once"
          ? ["allow_once"]
          : action === "allow_always"
            ? ["allow_always"]
            : ["reject_once", "reject_always"],
      );
    if (!item || !opt) return false;
    void run(() => respondPermission(current.agent.id, item, opt));
    return true;
  };

  // Keyboard (see lib/approvalKeys): J/K move · ⏎ open · E done · ⇧E archive · A/D answer · ⇧A always · ⇧D open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!current) return;
      const action = approvalActionFor(e);
      if (action) {
        // Questions are answered in their card (or in the agent): A / D do nothing there.
        if (shouldIgnoreApprovalKey(e) || current.reason !== "permission" || questionAgents.has(current.agent.id))
          return;
        e.preventDefault();
        if (action === "deny_reason") useUi.getState().openAgent(current.agent.id);
        else if (action === "allow_always") {
          if (arm.current.press("always", setAlwaysArmed)) answer("allow_always");
        } else answer(action);
        return;
      }
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (isEditableTarget(e.target)) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"]')) return;
      const k = e.key;
      if (k === "j") {
        e.preventDefault();
        step(1);
      } else if (k === "k") {
        e.preventDefault();
        step(-1);
      } else if (k === "Enter" && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        useUi.getState().openAgent(current.agent.id);
      } else if (k === "e") {
        e.preventDefault();
        void markDone(current);
      } else if (k === "E") {
        e.preventDefault();
        void archive(current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Arrow keys only move while the list itself has focus (roving focus between rows).
  const listRef = useRef<HTMLUListElement>(null);
  const onListKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? queue.length - 1
          : (index + (e.key === "ArrowDown" ? 1 : -1) + queue.length) % queue.length;
    const id = queue[next]?.agent.id;
    if (!id) return;
    select(id);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>(`[data-agent="${id}"]`)?.focus());
  };

  return (
    <div className="@container flex h-full flex-col">
      {!current ? (
        <AllClear />
      ) : (
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="Waiting agents"
            className="hidden w-[300px] shrink-0 flex-col overflow-y-auto border-r border-line bg-panel/60 p-2 @3xl:flex"
          >
            <ul ref={listRef} className="space-y-px" aria-label="Queue" onKeyDown={onListKeyDown}>
              {queue.map((e, i) => (
                <QueueRow
                  key={e.agent.id}
                  agent={e.agent}
                  reason={e.reason}
                  asking={questionAgents.has(e.agent.id)}
                  active={e.agent.id === current.agent.id}
                  heading={sectionHeading(e.reason, queue[i - 1]?.reason)}
                  onSelect={select}
                />
              ))}
            </ul>
          </nav>
          <section aria-label="Current agent" className="flex min-w-0 flex-1 flex-col">
            {/* Narrow panes: a compact stepper instead of the list. */}
            <div className="flex items-center gap-2 border-b border-line px-4 py-2 @3xl:hidden">
              <Button size="icon-xs" variant="ghost" aria-label="Previous" onClick={() => step(-1)}>
                <ChevronLeft className="!h-3.5 !w-3.5" />
              </Button>
              <span className="text-[12px] text-muted tabular" aria-live="polite">
                {index + 1} of {queue.length}
              </span>
              <Button size="icon-xs" variant="ghost" aria-label="Next" onClick={() => step(1)}>
                <ChevronRight className="!h-3.5 !w-3.5" />
              </Button>
            </div>
            <NeedsYouDetail
              key={current.agent.id}
              entry={current}
              onDone={() => void markDone(current)}
              onArchive={() => void archive(current)}
              alwaysArmed={alwaysArmed}
            />
          </section>
        </div>
      )}
      {current && <KeyHints reason={current.reason} asking={questionAgents.has(current.agent.id)} />}
    </div>
  );
}

/** Agents stuck on you come first; finished work waiting to be looked at gets its own, quieter section. */
function sectionHeading(reason: NeedsReason, previous: NeedsReason | undefined): string | null {
  const review = reason === "done";
  if (previous === undefined) return review ? "Ready to review" : "Needs you";
  return review && previous !== "done" ? "Ready to review" : null;
}

/** Memoised: props are the (stable) agent object, so one agent updating doesn't re-render every row. */
const QueueRow = memo(function QueueRow({
  agent,
  reason,
  asking,
  active,
  heading,
  onSelect,
}: {
  agent: Agent;
  reason: NeedsReason;
  asking: boolean;
  active: boolean;
  /** Section title to show above this row (the first row of each section). */
  heading: string | null;
  onSelect: (id: string) => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const backgroundRunning = backgroundActive(useBackground(agent.id));
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <li ref={ref}>
      {heading && (
        <p className="px-2.5 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-steel">
          {heading}
        </p>
      )}
      {/* The row is a div so the recovery buttons below can sit beside the open-agent button, not inside it. */}
      <div
        className={cn(
          "rounded-lg transition-colors",
          active ? "bg-gunmetal/70 shadow-[inset_0_0_0_1px_var(--border-strong)]" : "hover:bg-raised/60",
        )}
      >
        <button
          type="button"
          data-agent={agent.id}
          aria-current={active ? "true" : undefined}
          // Roving focus: only the selected row is in the tab order; arrows move within the list.
          tabIndex={active ? 0 : -1}
          onClick={() => onSelect(agent.id)}
          className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left"
        >
          <ProviderGlyph provider={agent.provider} customAgentId={agent.customAgentId} size="sm" className="mt-0.5" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium text-fg">{agent.title}</span>
            <span className="mt-1 flex items-center gap-1.5">
              <span className={cn("rounded-full border px-1.5 text-[10.5px] font-medium", REASON_TONE[reason])}>
                {reason === "rate_limited" ? (
                  <ResumesAt agent={agent} fallback={reasonLabel(reason, asking, backgroundRunning)} />
                ) : (
                  reasonLabel(reason, asking, backgroundRunning)
                )}
              </span>
              <span className="text-[11px] text-steel">
                <RelTime ts={agent.lastActivityAt} side="right" />
              </span>
            </span>
          </span>
        </button>
        {/* Reserved for every limit or error row (even while empty), so a state change never moves the list. */}
        {(reason === "rate_limited" || reason === "error") && (
          <div className="flex h-7 items-center pb-1.5 pl-[42px] pr-2.5">
            {needsRecovery(agent) && <RecoveryActions agent={agent} />}
          </div>
        )}
      </div>
    </li>
  );
});

function AllClear() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-12 text-center">
      <div className="relative mb-6 h-28 w-28" aria-hidden>
        <span className="absolute inset-0 rounded-full border border-ok/15" />
        <span className="absolute inset-3 rounded-full border border-ok/25" />
        <span className="absolute inset-6 rounded-full border border-ok/35 bg-ok/[0.06]" />
        <span className="absolute inset-0 m-auto flex h-10 w-10 items-center justify-center rounded-full bg-ok/15 text-ok shadow-[0_0_24px_-4px_var(--ok)]">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path d="M5 12.5 10 17l9-10" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </div>
      <h2 className="text-[17px] font-semibold tracking-tight">All clear</h2>
      <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted">
        No approvals, errors or unread results. Agents that need you will line up here, most urgent first.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button variant="secondary" onClick={() => useUi.getState().openNewAgent()}>
          <Plus /> New agent
        </Button>
        <Button variant="ghost" onClick={() => useUi.getState().openMission("all")}>
          See all agents
        </Button>
      </div>
    </div>
  );
}

/** The keys that do something for the selected agent: Allow / Deny only exist for an approval. */
function KeyHints({ reason, asking }: { reason: NeedsReason; asking: boolean }) {
  return (
    <div className="texture flex h-10 shrink-0 items-center justify-center gap-4 border-t border-line bg-panel px-3 text-[11.5px] text-steel @3xl:gap-5">
      <Hint keys={["J", "K"]} label="Move" />
      <Hint keys={["E"]} label="Done" />
      {asking ? (
        <Hint keys={["↵"]} label="Open to answer" />
      ) : reason !== "permission" ? (
        <Hint keys={["↵"]} label="Open agent" />
      ) : (
        <>
          <Hint keys={["A"]} label="Allow" />
          <span className="hidden @3xl:contents">
            <Hint keys={["⇧", "A"]} label="Always (twice)" />
          </span>
          <Hint keys={["D"]} label="Deny" />
          <span className="hidden @3xl:contents">
            <Hint keys={["↵"]} label="Open agent" />
          </span>
        </>
      )}
      <span className="hidden @3xl:contents">
        <Hint keys={[modKey, "J"]} label="Next waiting" />
      </span>
      <Tooltip
        content={
          <span className="flex flex-col gap-1 py-0.5">
            <Hint keys={["J", "K"]} label="Move between agents" />
            <Hint keys={["E"]} label="Done (mark handled)" />
            <Hint keys={["⇧", "E"]} label="Archive" />
            <Hint keys={["A"]} label="Allow once" />
            <Hint keys={["⇧", "A"]} label="Always allow (press twice)" />
            <Hint keys={["D"]} label="Deny" />
            <Hint keys={["⇧", "D"]} label="Deny with a reason (opens the agent)" />
            <Hint keys={["↵"]} label="Open the agent" />
          </span>
        }
      >
        <button
          type="button"
          aria-label="All keyboard shortcuts"
          className="flex h-6 w-6 items-center justify-center rounded-md border border-line-strong text-[11px] font-medium text-muted transition-colors hover:text-fg @3xl:hidden"
        >
          ?
        </button>
      </Tooltip>
    </div>
  );
}

function Hint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="flex gap-0.5">
        {keys.map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </span>
      {label}
    </span>
  );
}
