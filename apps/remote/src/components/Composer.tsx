import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { expandCommandShortcut } from "@shared/slashCommands";
import { composerPlaceholders, filterCommands, insertCommand, pickPlaceholder, slashQuery } from "@/lib/composerLogic";
import { insertAtCaret } from "@/lib/templates";
import { MAX_ATTACHMENTS, mergeAttachments } from "@/lib/attachments";
import { cancelTurn, clearQueue, removeQueued, resumeQueue, sendPrompt, sendQueuedNow, toastError } from "@/lib/controller";
import { confirmAction } from "@/lib/confirm";
import { cn } from "@/lib/cn";
import { agentIdentity, isBusy } from "@/lib/meta";
import { draftKey } from "@/lib/drafts";
import { useAgentAsking } from "@/lib/selectors";
import { storage } from "@/lib/storage";
import { useStore } from "@/lib/store";
import type { Agent, Attachment, QueuedPrompt } from "@/lib/types";
import { AttachButton, AttachmentTray, usePhotoPicker } from "./Attachments";
import { Icon, Spinner } from "./Icon";
import { TemplateSheet } from "./TemplateSheet";

const MAX_HEIGHT = 168;

export function loadDraft(agentId: string) {
  return storage.get(draftKey(agentId)) ?? "";
}

function saveDraft(agentId: string, value: string) {
  if (value.trim()) storage.set(draftKey(agentId), value);
  else storage.remove(draftKey(agentId));
}

/** Photos picked but not sent, per agent (memory only: they can be megabytes). */
const draftPhotos = new Map<string, Attachment[]>();

/**
 * Sticky prompt box. Messages can be sent while the agent works (they queue
 * behind the current turn). Enter inserts a newline on touch keyboards and
 * sends with a hardware keyboard (Shift+Enter for a newline); Ctrl/⌘+Enter
 * always sends. Typing "/" offers the agent's slash commands. Text drafts
 * survive reloads per agent.
 */
export interface ComposerHandle {
  /** Put text back into the box (e.g. editing a failed message). */
  setText: (text: string) => void;
}

/**
 * The draft lives here (not in the agent screen) so typing only re-renders
 * the composer, never the timeline above it.
 */
export const Composer = memo(function Composer({
  agent,
  banner,
  handle,
}: {
  agent: Agent;
  banner?: ReactNode;
  handle?: RefObject<ComposerHandle | null>;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, onChange] = useState(() => loadDraft(agent.id));
  useImperativeHandle(handle, () => ({ setText: (text: string) => { onChange(text); ref.current?.focus({ preventScroll: true }); } }), []);
  const [attachments, setAttachments] = useState<Attachment[]>(() => draftPhotos.get(agent.id) ?? []);
  const picker = usePhotoPicker(attachments, (list) => setAttachments((cur) => mergeAttachments(cur, list).list));
  const customAgents = useStore((s) => s.customAgents);
  const templates = useStore((s) => s.templates);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const caret = useRef<{ start: number; end: number } | null>(null);
  const cancelling = useStore((s) => !!s.busy[`cancel:${agent.id}`]);
  const busy = isBusy(agent.status);
  const name = agentIdentity(agent, customAgents).short;
  const canSend = value.trim().length > 0 || attachments.length > 0;

  const query = slashQuery(value);
  const commands = useMemo(
    () => (query === null ? [] : filterCommands(agent.availableCommands ?? [], query)),
    [agent.availableCommands, query],
  );

  // The longest placeholder that fits on one line (a wrapped one would make the empty box taller).
  const asking = useAgentAsking(agent.id);
  const candidates = useMemo(() => composerPlaceholders(agent, name, asking), [agent.status, agent.unread, agent.availableCommands, name, asking]);
  const [placeholder, setPlaceholder] = useState(() => candidates[candidates.length - 1]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pick = () => {
      const ctx = document.createElement("canvas").getContext("2d");
      if (!ctx || el.clientWidth <= 0) return setPlaceholder(candidates[candidates.length - 1]);
      ctx.font = getComputedStyle(el).font;
      setPlaceholder(pickPlaceholder(candidates, (t) => ctx.measureText(t).width <= el.clientWidth - 2));
    };
    pick();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(pick);
    ro.observe(el);
    return () => ro.disconnect();
  }, [candidates]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [value]);

  // Drafts persist (debounced while typing, and immediately when leaving the
  // screen, e.g. with Android Back) so they're never lost.
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    const t = setTimeout(() => saveDraft(agent.id, value), 300);
    return () => clearTimeout(t);
  }, [agent.id, value]);
  useEffect(() => () => saveDraft(agent.id, latest.current), [agent.id]);
  useEffect(() => {
    if (attachments.length) draftPhotos.set(agent.id, attachments);
    else draftPhotos.delete(agent.id);
  }, [agent.id, attachments]);

  const send = useCallback(() => {
    // `/rc` → `/remote-control`: agents only act on a command's full name.
    const text = expandCommandShortcut(value.trim(), agent.availableCommands ?? []);
    if (!text && !attachments.length) return;
    onChange("");
    setAttachments([]);
    storage.remove(draftKey(agent.id));
    void sendPrompt(agent.id, text, attachments);
    // Keep the keyboard up on phones so follow-ups are quick.
    ref.current?.focus({ preventScroll: true });
  }, [agent.id, agent.availableCommands, attachments, onChange, value]);

  /** Open the template list, remembering where the caret was (the box blurs when the sheet opens). */
  const openTemplates = () => {
    const el = ref.current;
    caret.current = el ? { start: el.selectionStart, end: el.selectionEnd } : null;
    setTemplatesOpen(true);
  };

  /** A template goes in at the caret (replacing a selection); an empty box just takes it. */
  const insertTemplate = (text: string) => {
    const at = caret.current;
    const next = insertAtCaret(latest.current, text, at?.start ?? null, at?.end ?? null);
    onChange(next.text);
    // After the sheet has closed (the page behind it is inert until then).
    setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(next.caret, next.caret);
    }, 220);
  };

  const editQueued = useCallback(
    async (q: QueuedPrompt) => {
      const removed = await removeQueued(agent.id, q.id);
      if (!removed) return;
      const { text, attachments: photos } = removed;
      // Functional updates: the user may have typed while the request was out.
      if (text) onChange((v) => (v.trim() ? `${text}\n\n${v}` : text));
      if (photos.length) {
        let dropped = 0;
        setAttachments((cur) => {
          const merged = mergeAttachments(cur, photos);
          dropped = merged.dropped;
          return merged.list;
        });
        queueMicrotask(() => {
          if (dropped) toastError("Some photos weren't restored", new Error(`You can attach up to ${MAX_ATTACHMENTS} photos.`));
        });
      }
      ref.current?.focus({ preventScroll: true });
    },
    [agent.id],
  );

  // Publish our height so the "Latest" button and toasts sit just above us.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const set = () => document.documentElement.style.setProperty("--composer-h", `${Math.round(el.getBoundingClientRect().height)}px`);
    const ro = new ResizeObserver(set);
    ro.observe(el);
    set();
    return () => {
      ro.disconnect();
      document.documentElement.style.setProperty("--composer-h", "0px");
    };
  }, []);

  return (
    <div
      ref={root}
      className="chrome sticky z-20 border-t border-line/70 pb-[max(10px,var(--safe-bottom-kb))]"
      style={{ bottom: "var(--kb, 0px)" }}
    >
      {banner}
      <QueueStack agent={agent} onEdit={editQueued} />
      {commands.length > 0 && (
        <div className="mx-auto w-full max-w-[860px] px-safe pt-2">
          <ul
            aria-label="Slash commands"
            className="max-h-[232px] overflow-y-auto overscroll-contain rounded-2xl border border-line-strong bg-card py-1 shadow-[0_-12px_32px_-16px_rgba(0,0,0,0.8)]"
          >
            {commands.map((c) => (
              <li key={c.name}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(insertCommand(c));
                    ref.current?.focus({ preventScroll: true });
                  }}
                  className="press-row flex min-h-11 w-full items-baseline gap-2 px-3.5 py-2 text-left"
                >
                  <span className="shrink-0 font-mono text-[13.5px] text-accent">/{c.name.replace(/^\//, "")}</span>
                  {c.hint && <span className="shrink-0 font-mono text-[12px] text-steel">{c.hint}</span>}
                  {c.description && <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{c.description}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <AttachmentTray
        attachments={attachments}
        onRemove={(i) => setAttachments((a) => a.filter((_, j) => j !== i))}
        className="mx-auto w-full max-w-[860px] px-safe pt-3 pr-3"
      />
      <form
        className="mx-auto flex w-full max-w-[860px] items-end gap-1.5 px-safe pt-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        {picker.element}
        <AttachButton picker={picker} className="-ml-1.5" />
        {templates.length > 0 && (
          <button
            type="button"
            onClick={openTemplates}
            aria-label="Insert a template"
            className="press hit relative -ml-1.5 inline-flex h-12 w-10 shrink-0 items-center justify-center rounded-full text-steel active:bg-raised active:text-fg"
          >
            <Icon name="bookText" size={21} />
          </button>
        )}
        <label className="sr-only" htmlFor={`composer-${agent.id}`}>
          Message {name}
        </label>
        <div className="flex min-h-12 min-w-0 flex-1 items-center rounded-[22px] border border-line-strong bg-card px-4 py-[9px] focus-within:border-accent/60 edge">
          <textarea
            id={`composer-${agent.id}`}
            ref={ref}
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab" && commands.length) {
                e.preventDefault();
                onChange(insertCommand(commands[0]));
                return;
              }
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              const fine = window.matchMedia("(pointer: fine)").matches;
              if (e.metaKey || e.ctrlKey || (fine && !e.shiftKey)) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={placeholder}
            enterKeyHint="send"
            autoComplete="off"
            autoCorrect="on"
            spellCheck
            className="block max-h-[168px] w-full resize-none bg-transparent text-[16px] leading-[22px] text-fg outline-none placeholder:text-steel"
          />
        </div>
        {busy && !canSend ? (
          <button
            type="button"
            onClick={() => void cancelTurn(agent.id)}
            disabled={cancelling}
            aria-label="Stop the current turn"
            className="press inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-err/40 bg-err/12 text-err disabled:opacity-60"
          >
            {cancelling ? <Spinner size={18} /> : <Icon name="stop" size={20} />}
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend}
            aria-label={busy ? "Queue message" : "Send"}
            className={cn(
              "press inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full",
              canSend ? "bg-accent text-accent-fg shadow-[0_6px_18px_-6px_var(--accent)]" : "bg-raised text-steel",
            )}
          >
            <Icon name="arrowUp" size={22} strokeWidth={2.2} />
          </button>
        )}
      </form>
      <TemplateSheet open={templatesOpen} templates={templates} onClose={() => setTemplatesOpen(false)} onInsert={insertTemplate} />
    </div>
  );
});

/** Messages waiting behind the current turn: one row (count, state) that opens into the list with labelled actions. */
function QueueStack({ agent, onEdit }: { agent: Agent; onEdit: (q: QueuedPrompt) => void }) {
  const queue = agent.queue ?? [];
  const [expanded, setExpanded] = useState(false);
  const busy = useStore((s) => s.busy);
  const count = queue.length;
  // An empty queue starts collapsed next time.
  useEffect(() => {
    if (!count) setExpanded(false);
  }, [count]);
  if (!count) return null;
  const open = expanded;
  const clearAll = (
    <button
      type="button"
      onClick={async () => {
        const ok = await confirmAction({
          title: `Clear ${count} queued messages?`,
          body: "They'll be removed without running.",
          confirmLabel: "Clear all",
          destructive: true,
        });
        if (ok) void clearQueue(agent.id);
      }}
      className="press relative inline-flex h-11 shrink-0 items-center rounded-lg px-2.5 text-[13px] font-semibold text-muted"
    >
      Clear all
    </button>
  );
  return (
    <section aria-label="Queued messages" className="mx-auto w-full max-w-[860px] px-safe pt-2">
      <div className="flex items-center rounded-xl border border-line bg-card edge">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={open}
          className="press-row flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl pr-2 pl-3 text-left text-[13px]"
        >
          <Icon name="clock" size={15} className="shrink-0 text-steel" />
          <span className="shrink-0 font-semibold text-fg">{count} queued</span>
          {agent.queuePaused ? (
            <span className="min-w-0 truncate font-medium text-warn">Queue paused</span>
          ) : (
            <span className="min-w-0 truncate text-steel">
              {count === 1 || open ? "Runs after this turn" : queue[0].text.trim() || "Photos"}
            </span>
          )}
          <Icon name="chevronDown" size={16} className={cn("ml-auto shrink-0 text-steel transition-transform duration-150", open && "rotate-180")} />
        </button>
        {open && count >= 2 && !agent.queuePaused && clearAll}
        {agent.queuePaused && (
          <button
            type="button"
            onClick={() => void resumeQueue(agent.id)}
            disabled={!!busy[`queue-resume:${agent.id}`]}
            className="press relative mr-1 inline-flex h-11 shrink-0 items-center rounded-lg px-2.5 text-[13px] font-semibold text-accent disabled:opacity-50"
          >
            Resume queue
          </button>
        )}
      </div>
      {open && (
        <div className="animate-fade mt-1.5">
          <ul className="max-h-[min(30dvh,260px)] space-y-1.5 overflow-y-auto overscroll-contain">
            {queue.map((q) => (
              <QueueItem key={q.id} agent={agent} q={q} sending={!!busy[`queue:${q.id}`]} onEdit={onEdit} />
            ))}
          </ul>
          {count >= 2 && agent.queuePaused && clearAll}
        </div>
      )}
    </section>
  );
}

const QUEUE_ACTION = "press relative inline-flex h-11 min-w-0 flex-1 items-center justify-center rounded-lg px-1 text-[13px] font-semibold whitespace-nowrap active:bg-raised disabled:opacity-50";

/** One queued message with its labelled actions: Send now, Stop & send, Edit, Remove. */
function QueueItem({ agent, q, sending, onEdit }: { agent: Agent; q: QueuedPrompt; sending: boolean; onEdit: (q: QueuedPrompt) => void }) {
  // Steering agents take it into the running turn; a slash command only works at
  // the start of a turn, so it goes first in line instead.
  const working = isBusy(agent.status);
  const steers = !!agent.steerable && working;
  const isCommand = q.text.trimStart().startsWith("/");
  const sendTitle = !working
    ? "Send now"
    : !agent.steerable
      ? "Send now (interrupts the current turn)"
      : isCommand
        ? "Run next (when the current turn ends)"
        : "Send now (adds it to the running turn)";
  return (
    <li className="animate-fade rounded-2xl border border-line-strong bg-card px-3.5 pt-2.5 pb-1 edge">
      <p className="line-clamp-2 text-[14px] leading-[1.35] break-words text-fg">{q.text || "(photos only)"}</p>
      {q.attachments > 0 && (
        <span className="mt-0.5 inline-flex items-center gap-1 text-[12px] text-steel">
          <Icon name="image" size={13} />
          {q.attachments === 1 ? "1 photo" : `${q.attachments} photos`}
        </span>
      )}
      <div className="-mx-2 mt-1 flex items-center border-t border-line/60 pt-0.5">
        <button
          type="button"
          onClick={() => void sendQueuedNow(agent.id, q.id)}
          disabled={sending}
          title={sendTitle}
          aria-label={sendTitle}
          className={cn(QUEUE_ACTION, "text-accent")}
        >
          {sending ? <Spinner size={15} /> : working && isCommand ? "Run next" : "Send now"}
        </button>
        {steers && !isCommand && (
          <button
            type="button"
            onClick={async () => {
              const ok = await confirmAction({
                title: "Stop the current turn?",
                body: "The agent stops what it's doing and runs this message instead.",
                confirmLabel: "Stop & send",
                destructive: true,
              });
              if (ok) void sendQueuedNow(agent.id, q.id, true);
            }}
            disabled={sending}
            title="Stops the current turn and runs this instead"
            className={cn(QUEUE_ACTION, "text-warn")}
          >
            Stop &amp; send
          </button>
        )}
        <button type="button" onClick={() => onEdit(q)} disabled={sending} className={cn(QUEUE_ACTION, "text-muted")}>
          Edit
        </button>
        <button type="button" onClick={() => void removeQueued(agent.id, q.id)} disabled={sending} className={cn(QUEUE_ACTION, "text-muted")}>
          Remove
        </button>
      </div>
    </li>
  );
}
