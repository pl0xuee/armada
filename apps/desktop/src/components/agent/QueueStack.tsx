import { ChevronDown, CornerDownRight, ImageIcon, ListOrdered, Pause, Pencil, Play, X, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Agent, QueuedPrompt, Attachment } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { ConfirmDialog } from "../ui/alert-dialog";
import { Spinner } from "../ui/misc";
import { Tooltip } from "../ui/tooltip";

const VISIBLE = 3;

/**
 * Messages sent while the agent was busy. They aren't in the timeline until they run,
 * so they live here, above the composer, with Edit / Send now / remove.
 */
export function QueueStack({
  agent,
  onEdit,
}: {
  agent: Agent;
  onEdit: (text: string, attachments: Attachment[]) => void;
}) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

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
  const shown = expanded ? queue : queue.slice(0, VISIBLE);

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

  const sendNow = async (q: QueuedPrompt) => {
    try {
      await api.sendQueuedNow(agent.id, q.id);
    } catch (e) {
      toast.error("Couldn't send it now", { description: errorMessage(e) });
    }
  };

  return (
    <section
      aria-label="Queued messages"
      className={cn(
        "mb-2 overflow-hidden rounded-xl border bg-card/70 edge",
        paused ? "border-warn/35" : "border-line-strong",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 border-b px-3 py-1.5 text-[11.5px]",
          paused ? "border-warn/20 bg-warn/[0.07] text-warn" : "border-line text-muted",
        )}
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
            </>
          )}
        </span>
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
          {queue.length > VISIBLE && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-steel transition-colors hover:bg-raised hover:text-fg"
            >
              {expanded ? "Show fewer" : `Show all ${queue.length}`}
              <ChevronDown className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")} />
            </button>
          )}
        </span>
      </div>
      <ol className="max-h-[220px] divide-y divide-line overflow-y-auto">
        {shown.map((q, i) => (
          <QueueRow
            key={q.id}
            index={i + 1}
            item={q}
            busy={busy}
            canSendNow={canSendNow}
            onEdit={() => void remove(q, true)}
            onRemove={() => void remove(q, false)}
            onSendNow={() => sendNow(q)}
          />
        ))}
      </ol>
      {!expanded && queue.length > VISIBLE && (
        <div className="border-t border-line px-3 py-1 text-[11px] text-steel">+{queue.length - VISIBLE} more</div>
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
  onEdit,
  onRemove,
  onSendNow,
}: {
  index: number;
  item: QueuedPrompt;
  busy: boolean;
  canSendNow: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onSendNow: () => Promise<void>;
}) {
  // Interrupting a running turn is destructive: first click arms, second confirms.
  const [armed, setArmed] = useState(false);
  const [sending, setSending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const clickSendNow = async () => {
    if (busy && !armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), 3500);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setArmed(false);
    setSending(true);
    await onSendNow();
    setSending(false);
  };

  const iconBtn =
    "inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-[11.5px] text-muted transition-colors hover:bg-raised hover:text-fg focus-visible:bg-raised";

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
          <Tooltip
            content={
              armed
                ? "Click again to stop the current turn and run this now"
                : busy
                  ? "Stop the current turn and run this next"
                  : "Run this next"
            }
          >
            <button
              type="button"
              className={cn(iconBtn, armed && "bg-warn/15 text-warn hover:bg-warn/25 hover:text-warn")}
              onClick={() => void clickSendNow()}
              disabled={sending}
              aria-label={armed ? `Interrupt? Confirm sending message ${index} now` : `Send now: message ${index}`}
            >
              {sending ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : armed ? (
                <Zap className="h-3.5 w-3.5" />
              ) : (
                <CornerDownRight className="h-3.5 w-3.5" />
              )}
              <span className="max-sm:hidden">{armed ? "Interrupt?" : "Send now"}</span>
            </button>
          </Tooltip>
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
