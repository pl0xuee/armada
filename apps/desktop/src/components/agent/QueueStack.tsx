import { ChevronDown, CornerDownRight, ImageIcon, ListOrdered, Pause, Pencil, Play, X, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useIdentity } from "@/hooks/useIdentity";
import { sendNowPlan, type SendNowPlan } from "@/lib/sendNow";
import type { Agent, QueuedPrompt, Attachment } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { ConfirmDialog } from "../ui/alert-dialog";
import { Spinner } from "../ui/misc";
import { Tooltip } from "../ui/tooltip";

/**
 * Messages sent while the agent was busy. They aren't in the timeline until they run,
 * so they live here, above the composer, with Edit / Send now / remove.
 */
export function QueueStack({
  agent,
  onEdit,
  embedded = false,
}: {
  agent: Agent;
  onEdit: (text: string, attachments: Attachment[]) => void;
  /** A row of the pinned dock: no card of its own. */
  embedded?: boolean;
}) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const name = useIdentity(agent.provider, agent.customAgentId).short;

  // Forget optimistic hides once the backend confirms the item is gone.
  useEffect(() => {
    setHidden((h) => {
      const ids = new Set(agent.queue.map((q) => q.id));
      const next = new Set([...h].filter((id) => ids.has(id)));
      return next.size === h.size ? h : next;
    });
  }, [agent.queue]);

  const queue = agent.queue.filter((q) => !hidden.has(q.id));
  if (queue.length === 0) return null;

  const busy = agent.status === "working" || agent.status === "starting" || agent.status === "needs_permission";
  const canSendNow = agent.running && agent.status !== "interrupted" && agent.status !== "stopped";
  // Shut down / interrupted: the composer is replaced by the Resume banner, so "sending
  // resumes it" would be misleading; the queue runs once the agent is resumed.
  const needsResume = agent.status === "interrupted" || agent.status === "stopped" || !agent.running;
  const paused = agent.queuePaused || needsResume;

  const hide = (id: string, on: boolean) =>
    setHidden((h) => {
      const next = new Set(h);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const remove = async (q: QueuedPrompt, edit: boolean) => {
    hide(q.id, true);
    try {
      const removed = await api.removeQueued(agent.id, q.id);
      if (edit) {
        if (removed === null) toast("That message already ran", { description: "It's in the conversation now." });
        else onEdit(removed.text, removed.attachments);
      }
    } catch (e) {
      hide(q.id, false);
      toast.error(edit ? "Couldn't edit the queued message" : "Couldn't remove the queued message", {
        description: errorMessage(e),
      });
    }
  };

  const resumeQueue = async () => {
    setResuming(true);
    try {
      await api.resumeQueue(agent.id);
    } catch (e) {
      toast.error("Couldn't resume the queue", { description: errorMessage(e) });
    } finally {
      setResuming(false);
    }
  };

  const clearAll = async () => {
    setClearing(true);
    try {
      const n = await api.clearQueue(agent.id);
      toast(`Cleared ${n} queued message${n === 1 ? "" : "s"}`);
      setConfirmClear(false);
    } catch (e) {
      toast.error("Couldn't clear the queue", { description: errorMessage(e) });
    } finally {
      setClearing(false);
    }
  };

  const sendNow = async (q: QueuedPrompt, interrupt: boolean) => {
    // Said plainly when it can't go into the running turn: it waits for the turn instead of stopping it.
    const plan = sendNowPlan(agent, q.text, busy, name);
    try {
      await api.sendQueuedNow(agent.id, q.id, interrupt);
      if (!interrupt && plan.note) toast(plan.note.title, { description: plan.note.description });
    } catch (e) {
      toast.error(interrupt ? "Couldn't stop and send" : "Couldn't send it now", { description: errorMessage(e) });
    }
  };

  return (
    <section
      aria-label="Queued messages"
      className={cn(
        "shrink-0 overflow-hidden",
        !embedded && "mb-2 rounded-xl border bg-card/70 edge",
        !embedded && (paused ? "border-warn/35" : "border-line-strong"),
        embedded && paused && "bg-warn/[0.04]",
      )}
    >
      <div
        className={cn(
          "flex h-8 items-center gap-2 px-3 text-[11.5px]",
          expanded && "border-b",
          paused ? "border-warn/20 bg-warn/[0.07] text-warn" : "border-line text-muted",
        )}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse queued messages" : "Expand queued messages"}
          className="-mx-1 flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-raised/60"
        >
          {paused ? <Pause className="h-3.5 w-3.5 shrink-0" /> : <ListOrdered className="h-3.5 w-3.5 shrink-0" />}
          <span className="min-w-0 truncate font-medium">
            {needsResume && !agent.queuePaused ? (
              "Resume to run queued messages"
            ) : paused ? (
              needsResume ? (
                "Queue paused"
              ) : (
                "Queue paused — sending (or Resume queue) runs it"
              )
            ) : (
              <>
                <span className="tabular text-fg">{queue.length}</span> queued
                <span className="text-steel"> · {busy ? "runs after the current turn" : "runs next"}</span>
                {!expanded && queue[0].text && (
                  <span className="text-steel"> · “{queue[0].text.replace(/\s+/g, " ").trim()}”</span>
                )}
              </>
            )}
          </span>
          <ChevronDown className={cn("h-3 w-3 shrink-0 text-steel transition-transform", !expanded && "-rotate-90")} />
        </button>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {agent.queuePaused && (
            <button
              type="button"
              onClick={() => void resumeQueue()}
              disabled={resuming}
              className="flex items-center gap-1 rounded-md border border-warn/35 bg-warn/10 px-1.5 py-0.5 font-medium text-warn transition-colors hover:bg-warn/20 disabled:opacity-60"
            >
              {resuming ? <Spinner className="h-3 w-3 text-current" /> : <Play className="h-3 w-3" />}
              Resume queue
            </button>
          )}
          {queue.length >= 2 && (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              className="rounded-md px-1.5 py-0.5 text-steel transition-colors hover:bg-raised hover:text-fg"
            >
              Clear all
            </button>
          )}
        </span>
      </div>
      {expanded && (
        <ol className="max-h-[min(150px,18vh)] divide-y divide-line overflow-y-auto">
          {queue.map((q, i) => (
            <QueueRow
              key={q.id}
              index={i + 1}
              item={q}
              busy={busy}
              canSendNow={canSendNow}
              plan={sendNowPlan(agent, q.text, busy, name)}
              onEdit={() => void remove(q, true)}
              onRemove={() => void remove(q, false)}
              onSendNow={(interrupt) => sendNow(q, interrupt)}
            />
          ))}
        </ol>
      )}
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={(o) => !clearing && setConfirmClear(o)}
        danger
        busy={clearing}
        title={`Clear ${queue.length} queued messages?`}
        description="They haven't been sent yet and can't be recovered."
        confirmLabel="Clear all"
        onConfirm={clearAll}
      />
    </section>
  );
}

function QueueRow({
  index,
  item,
  busy,
  canSendNow,
  plan,
  onEdit,
  onRemove,
  onSendNow,
}: {
  index: number;
  item: QueuedPrompt;
  busy: boolean;
  canSendNow: boolean;
  /** What "Send now" will do for this message (see lib/sendNow.ts). */
  plan: SendNowPlan;
  onEdit: () => void;
  onRemove: () => void;
  onSendNow: (interrupt: boolean) => Promise<void>;
}) {
  // Stopping a running turn is destructive: first click arms, second confirms.
  const [armed, setArmed] = useState(false);
  const [sending, setSending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const send = async (interrupt: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    setArmed(false);
    setSending(true);
    await onSendNow(interrupt);
    setSending(false);
  };

  /** Stops the turn: needs a second click while it is running. */
  const clickInterrupt = () => {
    if (busy && !armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), 3500);
      return;
    }
    void send(true);
  };

  const iconBtn =
    "inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-[11.5px] text-muted transition-colors hover:bg-raised hover:text-fg focus-visible:bg-raised";
  const armedBtn = "bg-warn/15 text-warn hover:bg-warn/25 hover:text-warn";

  return (
    <li className="group flex items-start gap-2.5 px-3 py-2">
      <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-line bg-raised text-[10.5px] font-semibold text-steel tabular">
        {index}
      </span>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 whitespace-pre-wrap break-words text-[12.5px] leading-snug text-fg/90">
          {item.text || <span className="italic text-steel">(images only)</span>}
        </p>
        {item.attachments > 0 && (
          <span className="mt-1 inline-flex items-center gap-1 rounded border border-line px-1 text-[10.5px] text-steel">
            <ImageIcon className="h-3 w-3" />
            {item.attachments} image{item.attachments === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip content="Edit: take it back into the composer">
          <button type="button" className={iconBtn} onClick={onEdit} aria-label={`Edit queued message ${index}`}>
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
        {canSendNow && (
          <>
            <Tooltip content={plan.hint}>
              <button
                type="button"
                className={iconBtn}
                onClick={() => void send(false)}
                disabled={sending}
                aria-label={
                  plan.mode === "deliver"
                    ? `Send now: add message ${index} to the running turn`
                    : plan.mode === "front"
                      ? `Run next: message ${index}, when the current turn ends`
                      : `Send now: message ${index}`
                }
              >
                {sending ? <Spinner className="h-3.5 w-3.5" /> : <CornerDownRight className="h-3.5 w-3.5" />}
                <span className="max-sm:hidden">{plan.label}</span>
              </button>
            </Tooltip>
            {busy && (
              <Tooltip
                content={
                  armed
                    ? "Click again to stop the current turn and run this instead"
                    : "Stop & send: stop the current turn (work in progress is lost) and run this instead"
                }
              >
                <button
                  type="button"
                  className={cn(iconBtn, armed && armedBtn)}
                  onClick={clickInterrupt}
                  disabled={sending}
                  aria-label={
                    armed ? `Stop the turn? Confirm sending message ${index} instead` : `Stop & send: message ${index}`
                  }
                >
                  <Zap className="h-3.5 w-3.5" />
                  <span className="max-sm:hidden">{armed ? "Stop turn?" : "Stop & send"}</span>
                </button>
              </Tooltip>
            )}
          </>
        )}
        <Tooltip content="Remove from queue">
          <button
            type="button"
            className={cn(iconBtn, "hover:text-err")}
            onClick={onRemove}
            aria-label={`Remove queued message ${index}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </div>
    </li>
  );
}
