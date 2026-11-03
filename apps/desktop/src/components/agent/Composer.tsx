import { ArrowUp, BookText, ChevronDown, FileText, GitFork, ListPlus, Play, RotateCcw, Square } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { cancelTurn, resumeAgent } from "@/lib/actions";
import { api } from "@/lib/api";
import { MAX_ATTACHMENTS } from "@/lib/attachments";
import { canStartHelper, decideBusySend, type BusyIntent } from "@/lib/helpers";
import { restoreDraft } from "@/lib/draftRestore";
import { isSlashCommand } from "@/lib/sendNow";
import { commandRank, expandCommandShortcut } from "@/lib/slashCommands";
import type { Agent, SlashCommand, Attachment } from "@/lib/types";
import { cn, errorMessage, modKey } from "@/lib/utils";
import { useDebounced } from "@/hooks/useDebounced";
import { useElementWidth } from "@/hooks/useElementWidth";
import { useIdentity } from "@/hooks/useIdentity";
import { useAttachments } from "@/hooks/useAttachments";
import { latestPendingQuestion } from "@/lib/question";
import { latestPending } from "../timeline/usePermissionKeys";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { getDraft, onAttachmentsInsert, onDraftInsert, setDraft } from "./drafts";
import { AttachButton, DropOverlay } from "../AttachControls";
import { ComposerVoiceButtons } from "../voice/ComposerVoiceButtons";
import { AttachmentStrip } from "../AttachmentStrip";
import { TemplatePicker } from "../TemplatePicker";
import { Button } from "../ui/button";
import { useIsDone } from "@/store/completion";
import { useBackground } from "@/store/background";
import { backgroundActive } from "@/lib/background";
import { Kbd } from "../ui/kbd";
import { Tooltip } from "../ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/menu";
import { ConfigOverflowMenu, ConfigSelect } from "./ConfigSelect";
import { PinnedDock } from "./PinnedDock";

const ESC_ARM_MS = 1500;
/** The textarea sizes itself to its text in CSS (`field-sizing: content`); otherwise the layout effect measures. */
const FIELD_SIZING =
  typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");

/** IME composition in progress (WebKit reports keyCode 229 and may not set isComposing). */
function composing(e: React.KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

interface Suggestion {
  key: string;
  label: React.ReactNode;
  detail?: React.ReactNode;
}

/** "@src/au" right before the caret -> "src/au"; null when not typing a mention. */
function mentionQuery(text: string, caret: number): string | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return m ? m[2] : null;
}

/** "/rev" -> "rev"; null when the text isn't a bare command being typed. */
function slashQuery(text: string): string | null {
  const m = /^\/(\S*)$/.exec(text);
  return m ? m[1].toLowerCase() : null;
}

function ComposerImpl({
  agent,
  focused = true,
  compact = false,
}: {
  agent: Agent;
  focused?: boolean;
  compact?: boolean;
}) {
  const [text, setText] = useState(() => getDraft(agent.id));
  // Latest text for async callbacks (queue Edit resolves after an await).
  const textRef = useRef(text);
  textRef.current = text;
  const [escArmed, setEscArmed] = useState(false);
  const escTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sending, setSending] = useState(false);
  const [hint, setHint] = useState<{ prefix: string; hint: string } | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [caret, setCaret] = useState(0);
  // Results tagged with the query they answer, so a fast Enter never picks a stale file.
  const [files, setFiles] = useState<{ query: string; list: string[] }>({ query: "", list: [] });
  const attach = useAttachments([], agent.id);
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  // The shortcut hints need about 520px; in a narrow tile they would be cut off mid-word.
  const roomForHints = width === 0 || width >= 520;
  // Floating things anchored bottom-right (toasts, the voice assistant panel) sit above the
  // composer via --composer-clear, so they never cover Send / Queue / Stop.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el || !focused) return;
    const root = document.documentElement;
    const set = () =>
      root.style.setProperty("--composer-clear", `${Math.ceil(el.getBoundingClientRect().height) + 8}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--composer-clear");
    };
  }, [wrapRef, focused]);
  // Toolbar tiers by available width: labels → icons → extra options in a "+" menu.
  const roomy = width === 0 || width >= 700;
  const tight = width > 0 && width < 520;
  const ref = useRef<HTMLTextAreaElement>(null);
  const focusTick = useUi((s) => s.composerFocusTick);

  const working = agent.status === "working" || agent.status === "starting";
  const blocked = agent.status === "needs_permission";
  // A question waits above (typing here queues; it doesn't answer it).
  const asking = useApp((s) => blocked && latestPendingQuestion(s.items[agent.id]) !== null);
  // An approval waits too: its actions are docked above the composer (see ApprovalDock), so the
  // composer drops Stop / "Waiting…" while you answer.
  const approving = useApp((s) => blocked && latestPending(s.items[agent.id]) !== null);
  const docked = approving || asking;
  const resumable = agent.status === "interrupted" || agent.status === "stopped";
  const busy = working || blocked;
  // Sending while the agent works queues the message; it runs right after this turn.
  const busySend = useApp((s) => s.settings?.busySend ?? "deliver");
  const helperAllowed = canStartHelper(agent);
  const canSend = !resumable && (text.trim().length > 0 || attach.attachments.length > 0) && !sending;

  const query = slashQuery(text);
  const matches = useMemo(() => {
    if (query === null) return [];
    // Names first, then initials ("rc" finds remote-control), then anywhere in the name.
    return agent.availableCommands
      .map((c) => ({ c, rank: commandRank(c.name, query) }))
      .filter((m): m is { c: SlashCommand; rank: number } => m.rank !== null)
      .sort((a, b) => a.rank - b.rank)
      .map((m) => m.c);
  }, [agent.availableCommands, query]);
  const mention = slashQuery(text) === null ? mentionQuery(text, caret) : null;
  const debouncedMention = useDebounced(mention, 120);
  useEffect(() => {
    if (debouncedMention === null) {
      setFiles({ query: "", list: [] });
      return;
    }
    let cancelled = false;
    const q = debouncedMention;
    api
      .listFiles(agent.id, q)
      .then((f) => !cancelled && setFiles({ query: q, list: f }))
      .catch(() => !cancelled && setFiles({ query: q, list: [] }));
    return () => {
      cancelled = true;
    };
  }, [agent.id, debouncedMention]);

  const mode: "slash" | "mention" | null = slashDismissed
    ? null
    : matches.length > 0
      ? "slash"
      : mention !== null && files.query === mention && files.list.length > 0
        ? "mention"
        : null;
  const fileList = mode === "mention" ? files.list.slice(0, 50) : [];
  const suggestions: Suggestion[] =
    mode === "slash"
      ? matches.map((c) => ({
          key: c.name,
          label: (
            <>
              /{c.name}
              {c.hint && <span className="ml-1.5 text-steel">{c.hint}</span>}
            </>
          ),
          detail: c.description,
        }))
      : mode === "mention"
        ? fileList.map((f) => {
            const base = f.slice(f.lastIndexOf("/") + 1);
            const dir = f.slice(0, f.length - base.length);
            return {
              key: f,
              label: (
                <span className="flex items-center gap-2">
                  <FileText className="h-3.5 w-3.5 shrink-0 text-steel" />
                  {base}
                </span>
              ),
              detail: dir || null,
            };
          })
        : [];
  const slashOpen = suggestions.length > 0;
  // The list can shrink under a stale index (commands/files update); always clamp.
  const activeIndex = slashOpen ? Math.min(slashIndex, suggestions.length - 1) : 0;

  // Per-agent drafts survive switching agents.
  useEffect(() => {
    setText(getDraft(agent.id));
    setHint(null);
    setEscArmed(false);
  }, [agent.id]);
  useEffect(
    () => () => {
      if (escTimer.current) clearTimeout(escTimer.current);
    },
    [],
  );

  // Focus the composer on open, except while an approval is pending: then Y/A/N go to the
  // approval card (keyboard approvals), so keep focus off the textarea.
  const focusedForTick = useRef(focusTick);
  useEffect(() => {
    if (resumable || !focused) return;
    const explicit = focusTick !== focusedForTick.current;
    focusedForTick.current = focusTick;
    if (blocked && !explicit) return;
    ref.current?.focus();
  }, [agent.id, focusTick, resumable, focused]);

  // An approval arriving while the composer is focused with an empty draft releases focus.
  useEffect(() => {
    if (blocked && document.activeElement === ref.current && !ref.current?.value) ref.current?.blur();
  }, [blocked]);

  useEffect(() => setSlashIndex(0), [query, debouncedMention, mode]);

  // Auto-size. Browsers with `field-sizing: content` do it in CSS (no JS, no layout reads). Elsewhere:
  // appending only ever grows the box, so that case reads once and writes only if the text overflows;
  // anything else (a deletion, an edit in the middle) collapses and re-measures as before.
  const sized = useRef("");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || FIELD_SIZING) return;
    const prev = sized.current;
    sized.current = text;
    const max = Math.round(window.innerHeight * 0.4);
    if (!el.style.height && text === "") return;
    if (el.style.height && text.length > prev.length && text.startsWith(prev)) {
      if (el.scrollHeight > el.clientHeight) el.style.height = `${Math.min(el.scrollHeight, max)}px`;
      return;
    }
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [text]);

  const update = (v: string, nextCaret = v.length) => {
    setText(v);
    textRef.current = v;
    setCaret(nextCaret);
    setDraft(agent.id, v);
    if (escArmed) setEscArmed(false);
    if (hint && v !== hint.prefix) setHint(null);
    if (slashQuery(v) === null && mentionQuery(v, nextCaret) === null) setSlashDismissed(false);
  };

  // Text sent in from elsewhere (e.g. terminal output from the workspace panel).
  const updateRef = useRef(update);
  updateRef.current = update;
  useEffect(
    () =>
      onDraftInsert(agent.id, (insert) => {
        const cur = textRef.current;
        const next = cur.trim() ? `${cur.trimEnd()}\n\n${insert}` : insert;
        updateRef.current(next);
        requestAnimationFrame(() => {
          const el = ref.current;
          if (el) {
            el.focus();
            el.setSelectionRange(next.length, next.length);
          }
        });
      }),
    [agent.id],
  );

  // Images sent in from elsewhere (Preview screenshots and element crops).
  const setAttachmentsRef = useRef(attach.setAttachments);
  setAttachmentsRef.current = attach.setAttachments;
  useEffect(
    () =>
      onAttachmentsInsert(agent.id, (incoming) => {
        setAttachmentsRef.current((cur) => {
          const room = Math.max(0, MAX_ATTACHMENTS - cur.length);
          if (incoming.length > room)
            toast.warning(`Only ${MAX_ATTACHMENTS} images per message; some weren't attached`);
          return [...cur, ...incoming.slice(0, room)];
        });
      }),
    [agent.id],
  );

  const pickFile = (path: string) => {
    const before = text.slice(0, caret);
    const start = before.lastIndexOf("@");
    if (start < 0) return;
    const insert = `@${path} `;
    const next = `${text.slice(0, start)}${insert}${text.slice(caret)}`;
    const pos = start + insert.length;
    update(next, pos);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
      }
    });
  };

  const pick = (i: number) => {
    if (mode === "slash") {
      const c = matches[i];
      if (c) pickCommand(c);
    } else if (mode === "mention") {
      const f = fileList[i];
      if (f) pickFile(f);
    }
  };

  const pickCommand = (c: SlashCommand) => {
    const prefix = `/${c.name} `;
    update(prefix);
    setHint(c.hint ? { prefix, hint: c.hint } : null);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        el.setSelectionRange(prefix.length, prefix.length);
      }
    });
  };

  /** Text taken back from the queue: replace an empty draft, otherwise append (never overwrite). */
  const takeBack = (body: string, images: Attachment[] = []) => {
    const cur = textRef.current;
    const next = cur.trim() ? `${cur.trimEnd()}\n\n${body}` : body;
    update(next);
    if (images.length) attach.setAttachments((cur) => [...cur, ...images].slice(0, MAX_ATTACHMENTS));
    if (resumable) {
      toast("Moved to your draft", { description: "Resume the agent to edit and send it." });
      return;
    }
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.length, next.length);
      }
    });
  };
  // A stable handle for the pinned dock (memoized), so it doesn't re-render with every keystroke here.
  const takeBackRef = useRef(takeBack);
  takeBackRef.current = takeBack;
  const stableTakeBack = useCallback((body: string, images?: Attachment[]) => takeBackRef.current(body, images), []);

  const insertTemplate = (body: string) => {
    const el = ref.current;
    if (!text.trim() || !el) {
      update(body);
    } else {
      const start = el.selectionStart ?? text.length;
      const end = el.selectionEnd ?? text.length;
      update(`${text.slice(0, start)}${body}${text.slice(end)}`);
    }
    requestAnimationFrame(() => ref.current?.focus());
  };

  /** Dictated text goes in at the caret; with "send after dictation" it is sent right away. */
  const insertDictation = (spoken: string, autoSend: boolean) => {
    const el = ref.current;
    const cur = textRef.current;
    const start = el ? Math.min(el.selectionStart ?? cur.length, cur.length) : cur.length;
    const end = el ? Math.min(el.selectionEnd ?? start, cur.length) : cur.length;
    const before = cur.slice(0, start);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const inserted = `${lead}${spoken}`;
    const next = `${before}${inserted}${cur.slice(end)}`;
    update(next, start + inserted.length);
    if (autoSend) autoSendRef.current = next.trim();
    requestAnimationFrame(() => {
      const t = ref.current;
      if (!t) return;
      t.focus();
      t.setSelectionRange(start + inserted.length, start + inserted.length);
    });
  };
  const autoSendRef = useRef<string | null>(null);
  useEffect(() => {
    if (autoSendRef.current === null) return;
    const want = autoSendRef.current;
    autoSendRef.current = null;
    if (text.trim() !== want) return;
    if (canSend) void send();
    else toast.info("Dictation inserted, but the message can't be sent right now");
  });

  /**
   * Sends the message. `deliver`: while the agent works it goes into the running turn right away (it reads it
   * at its next step, nothing is stopped); otherwise it queues behind the turn (or just runs, when idle).
   * If sending fails the text comes back into the composer; the backend queues rather than drops a message
   * it couldn't deliver.
   */
  const submit = async (deliver: boolean) => {
    if (!canSend) return;
    const value = expandCommandShortcut(text.trim(), agent.availableCommands);
    const images = attach.attachments;
    setSending(true);
    update("");
    attach.clear();
    setHint(null);
    try {
      await api.sendPrompt(agent.id, value, images, deliver);
    } catch (e) {
      update(restoreDraft(textRef.current, value));
      attach.setAttachments(images);
      toast.error("Couldn't send prompt", { description: errorMessage(e) });
    } finally {
      setSending(false);
    }
  };

  /** Run the message in a new helper agent, in parallel with this one. */
  const startHelper = async () => {
    if (!canSend || !helperAllowed) return;
    const value = expandCommandShortcut(text.trim(), agent.availableCommands);
    const images = attach.attachments;
    setSending(true);
    update("");
    attach.clear();
    setHint(null);
    try {
      const helper = await api.spawnHelper(agent.id, value, images);
      useApp.getState().upsertAgent(helper);
      toast(`Started helper · ${helper.title}`, {
        action: { label: "Open", onClick: () => useUi.getState().openAgent(helper.id) },
      });
    } catch (e) {
      update(restoreDraft(textRef.current, value));
      attach.setAttachments(images);
      toast.error("Couldn't start a helper", { description: errorMessage(e) });
    } finally {
      setSending(false);
    }
  };

  /** The agent takes a message into its running turn now (not for commands, or while the queue is on hold). */
  const canDeliver = busy && !!agent.steerable && !agent.queuePaused && !isSlashCommand(text);

  /** What the main button does (and says) while busy. */
  const primary = decideBusySend(busySend, "queueButton", helperAllowed, canDeliver);
  /** The agent takes messages into a running turn (so the menu may offer it). */
  const agentTakesMidTurn = !!agent.steerable && !agent.queuePaused;

  /** One send gesture. While busy: into the running turn, queued, or a helper, per setting and gesture. */
  const send = async (intent: BusyIntent = "enter") => {
    if (!canSend) return;
    if (busy) {
      const d = decideBusySend(busySend, intent, helperAllowed, canDeliver);
      if (d === "helper") return void startHelper();
      return void submit(d === "deliver");
    }
    await submit(false);
  };

  /** Up arrow on an empty composer: the newest queued message comes back for editing. */
  const recallQueued = async () => {
    const last = agent.queue[agent.queue.length - 1];
    if (!last) return;
    try {
      const removed = await api.removeQueued(agent.id, last.id);
      if (removed === null) toast("That message already ran", { description: "It's in the conversation now." });
      else takeBack(removed.text, removed.attachments);
    } catch (e) {
      toast.error("Couldn't take the queued message back", { description: errorMessage(e) });
    }
  };

  /** Esc on an empty draft stops the turn, but only on a second press (never by accident). */
  const onEscape = () => {
    if (escArmed) {
      if (escTimer.current) clearTimeout(escTimer.current);
      setEscArmed(false);
      void cancelTurn(agent);
      return;
    }
    setEscArmed(true);
    if (escTimer.current) clearTimeout(escTimer.current);
    escTimer.current = setTimeout(() => setEscArmed(false), ESC_ARM_MS);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing(e)) return;
    if (slashOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setSlashIndex((activeIndex + d + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pick(activeIndex);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setSlashDismissed(true);
        return;
      }
    }
    if (
      e.key === "ArrowUp" &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      text === "" &&
      attach.attachments.length === 0 &&
      agent.queue.length > 0
    ) {
      // Like Claude Code: Up on an empty prompt takes your newest queued message back to edit it. (A held key
      // repeats before the first answer is back: the same message would be taken twice, and "already ran" shown.)
      e.preventDefault();
      if (!e.repeat) void recallQueued();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(e.metaKey || e.ctrlKey ? "modEnter" : "enter");
    } else if (e.key === "Escape" && busy && text.trim() === "" && attach.attachments.length === 0) {
      e.preventDefault();
      onEscape();
    }
  };

  const name = useIdentity(agent.provider, agent.customAgentId).short;
  const justDone = useIsDone(agent);
  const bg = useBackground(agent.id);
  const bgNote = !backgroundActive(bg)
    ? null
    : bg.workflows > 0
      ? "A workflow is still running"
      : "Background agents may still be running";
  const placeholder = blocked
    ? asking
      ? primary === "deliver"
        ? `Answer above, or type a message…`
        : `Answer above, or queue a message…`
      : primary === "deliver"
        ? `Approve or deny above, or type a message…`
        : `Approve or deny above, or queue a message for after this turn…`
    : working
      ? agent.queue.length > 0
        ? `${name} is working. ${primary === "deliver" ? "Type another message" : "Queue another message"}…  ↑ edits the last queued one`
        : primary === "deliver"
          ? `${name} is working. Type a follow-up: it reads it at its next step…`
          : `${name} is working. Queue a follow-up message…`
      : bgNote
        ? `Turn finished. ${bgNote}. Reply, or start something new…`
        : justDone
          ? `Done. Reply, or start something new…`
          : agent.availableCommands.length > 0
            ? `Message ${name}…  / for commands, @ for files`
            : `Message ${name}…  @ to mention files`;

  return (
    <div ref={wrapRef} data-dictation-scope className={cn("shrink-0 pb-4 pt-1", tight ? "px-3" : "px-6")}>
      <div className={cn("mx-auto w-full", width >= 1330 ? "max-w-[1000px]" : "max-w-[860px]")}>
        <PinnedDock
          agent={agent}
          focused={focused}
          compact={compact || tight}
          resumable={resumable}
          onEditQueued={stableTakeBack}
        />
        {resumable ? (
          <ResumeBanner agent={agent} />
        ) : (
          <div
            {...attach.dropHandlers}
            className={cn(
              "group relative rounded-2xl border bg-card shadow-[0_10px_40px_-16px_rgba(0,0,0,0.7)] transition-[border-color,box-shadow] duration-150 edge-strong",
              "border-line-strong focus-within:border-accent/50 focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_12%,transparent),0_10px_40px_-16px_rgba(0,0,0,0.7)]",
            )}
          >
            {attach.dragging && <DropOverlay />}
            {escArmed && (
              <div
                role="status"
                className="flex items-center gap-2 rounded-t-2xl border-b border-warn/25 bg-warn/[0.08] px-4 py-1.5 text-[12px] font-medium text-warn"
              >
                <Kbd>Esc</Kbd>
                {blocked
                  ? "Respond to the request above, or press Esc again to stop the turn"
                  : "Press Esc again to stop the turn"}
              </div>
            )}
            <input {...attach.inputProps} />
            {slashOpen && mode && (
              <SuggestMenu
                title={mode === "slash" ? `${name} commands` : "Files"}
                items={suggestions}
                active={activeIndex}
                onHover={setSlashIndex}
                onPick={pick}
                mono={mode === "slash"}
              />
            )}
            <AttachmentStrip
              attachments={attach.attachments}
              onRemove={attach.remove}
              className="px-4 pt-3"
              size={52}
            />
            {working && (
              <div className="shimmer-bar absolute inset-x-4 top-0 h-px overflow-hidden rounded-full" aria-hidden />
            )}
            <div className="relative">
              {hint && text === hint.prefix && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 whitespace-pre-wrap px-4 pb-1 pt-3.5 text-[13.5px] leading-relaxed"
                >
                  <span className="invisible">{text}</span>
                  <span className="text-steel">{hint.hint}</span>
                </div>
              )}
              <textarea
                ref={ref}
                value={text}
                rows={1}
                aria-label={`Message ${name}`}
                dir="auto"
                aria-autocomplete="list"
                aria-controls={slashOpen ? "slash-menu" : undefined}
                aria-activedescendant={slashOpen ? `suggest-${activeIndex}` : undefined}
                placeholder={placeholder}
                onChange={(e) => update(e.target.value, e.target.selectionStart ?? e.target.value.length)}
                onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
                onPaste={attach.onPaste}
                onKeyDown={onKeyDown}
                onBlur={() => setSlashDismissed(true)}
                onFocus={() => {
                  setSlashDismissed(false);
                  // Tabbing into another tile's composer makes that tile the focused one (a click already does).
                  if (compact && !focused) useUi.getState().openAgent(agent.id);
                }}
                className="relative block max-h-[40vh] min-h-[52px] w-full resize-none field-sizing-content bg-transparent px-4 pb-1 pt-3.5 text-[13.5px] leading-relaxed text-fg placeholder:text-steel focus:outline-none"
              />
            </div>
            <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-1">
              <div className="flex min-w-0 shrink-0 items-center gap-0.5">
                {(tight ? agent.configOptions.slice(0, 1) : agent.configOptions).map((opt) => (
                  <ConfigSelect key={opt.id} agent={agent} option={opt} compact={!roomy} />
                ))}
                {tight && <ConfigOverflowMenu agent={agent} options={agent.configOptions.slice(1)} />}
                <AttachButton onClick={attach.openPicker} count={attach.attachments.length} iconOnly={!roomy} />
                <TemplatePicker
                  onInsert={insertTemplate}
                  trigger={
                    roomy ? undefined : (
                      <button
                        type="button"
                        aria-label="Prompt templates"
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-fg data-[state=open]:bg-raised data-[state=open]:text-fg"
                      >
                        <BookText className="h-3.5 w-3.5" />
                      </button>
                    )
                  }
                />
                <span className={cn("mx-1.5 h-4 w-px bg-line", !busy && !roomForHints && "hidden")} aria-hidden />
              </div>
              <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[11.5px] text-steel">
                {busy ? (
                  <>
                    {/* Still dot with a glow: the shimmer line above and the header dot already move. */}
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        blocked ? "bg-warn shadow-[0_0_8px_var(--warn)]" : "bg-accent shadow-[0_0_8px_var(--accent)]",
                      )}
                    />
                    <span className={cn("min-w-0 truncate", width > 0 && width < 600 && "sr-only")}>
                      {blocked ? "Waiting for you" : "Working…"}
                    </span>
                  </>
                ) : (
                  <span className={cn("items-center gap-1", roomForHints ? "flex" : "hidden")}>
                    <Kbd>⏎</Kbd> send <span className="mx-1 text-line-strong">·</span> <Kbd>⇧</Kbd>
                    <Kbd>⏎</Kbd> newline
                  </span>
                )}
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                <ComposerVoiceButtons onText={insertDictation} />
                {busy && !docked && (
                  <Tooltip content="Stop this turn" shortcut={["Esc ×2"]}>
                    <Button
                      size="sm"
                      variant={blocked ? "ghost" : "secondary"}
                      onClick={() => void cancelTurn(agent)}
                      aria-label="Stop this turn"
                      className="gap-1.5"
                    >
                      <Square className="!h-3 !w-3 fill-current" />
                      {!tight && "Stop"}
                    </Button>
                  </Tooltip>
                )}
                {busy && docked && !canSend ? null : busy ? (
                  <div className="flex items-center">
                    <Tooltip
                      content={
                        primary === "deliver"
                          ? `Send now: ${name} reads it at its next step and keeps working. Nothing is stopped${helperAllowed ? ` · ${modKey}⏎ starts a helper instead` : ""}`
                          : primary === "helper"
                            ? "Start a helper: works in parallel and merges back"
                            : `Queue message: runs right after the current turn${helperAllowed ? ` · ${modKey}⏎ starts a helper instead` : ""}`
                      }
                      shortcut={["⏎"]}
                    >
                      <Button
                        size={tight ? "icon-sm" : "sm"}
                        // Flat until there's something to send, so it doesn't read as clickable.
                        variant={canSend ? "primary" : "secondary"}
                        disabled={!canSend}
                        onClick={() => void send("queueButton")}
                        aria-label={
                          primary === "deliver"
                            ? "Send into the running turn"
                            : primary === "helper"
                              ? "Start a helper with this message"
                              : "Queue message (runs after the current turn)"
                        }
                        className="rounded-l-lg rounded-r-none"
                      >
                        {primary === "deliver" ? (
                          <ArrowUp className="!h-4 !w-4" strokeWidth={2.5} />
                        ) : primary === "helper" ? (
                          <GitFork className="!h-4 !w-4" />
                        ) : (
                          <ListPlus className="!h-4 !w-4" />
                        )}
                        {!tight && (primary === "deliver" ? "Send" : primary === "helper" ? "Helper" : "Queue")}
                      </Button>
                    </Tooltip>
                    <DropdownMenu>
                      <Tooltip content="More ways to send" side="top">
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon-sm"
                            variant={canSend ? "primary" : "secondary"}
                            aria-label="More ways to send"
                            className="w-6 rounded-l-none rounded-r-lg border-l border-l-black/20"
                          >
                            <ChevronDown className="!h-3.5 !w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                      </Tooltip>
                      <DropdownMenuContent align="end" side="top">
                        {primary !== "deliver" && agentTakesMidTurn && (
                          <DropdownMenuItem disabled={!canSend} onSelect={() => void send("deliverMenu")}>
                            <ArrowUp /> Send into the running turn
                            <span className="ml-auto pl-4 text-[11px] text-steel">read at its next step</span>
                          </DropdownMenuItem>
                        )}
                        {primary !== "queue" && (
                          <DropdownMenuItem disabled={!canSend} onSelect={() => void send("queueMenu")}>
                            <ListPlus /> Queue until the turn ends
                            <span className="ml-auto pl-4 text-[11px] text-steel">nothing interrupted</span>
                          </DropdownMenuItem>
                        )}
                        {primary !== "helper" && helperAllowed && (
                          <DropdownMenuItem disabled={!canSend} onSelect={() => void send("helperMenu")}>
                            <GitFork /> Start a helper now
                            <span className="ml-auto pl-4 text-[11px] text-steel">{modKey}⏎</span>
                          </DropdownMenuItem>
                        )}
                        {!canSend && (
                          <div className="px-2.5 pb-1.5 pt-0.5 text-[11.5px] text-steel">Type a message first.</div>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ) : (
                  <Tooltip
                    content={agent.queuePaused && agent.queue.length > 0 ? "Send (resumes the paused queue)" : "Send"}
                    shortcut={["⏎"]}
                  >
                    <Button
                      size="icon-sm"
                      variant={canSend ? "primary" : "secondary"}
                      disabled={!canSend}
                      onClick={() => void send()}
                      aria-label={agent.queuePaused && agent.queue.length > 0 ? "Send and resume queue" : "Send"}
                      className="rounded-lg"
                    >
                      <ArrowUp className="!h-4 !w-4" strokeWidth={2.5} />
                    </Button>
                  </Tooltip>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SuggestMenu({
  title,
  items,
  active,
  onHover,
  onPick,
  mono,
}: {
  title: string;
  items: Suggestion[];
  active: number;
  onHover: (i: number) => void;
  onPick: (i: number) => void;
  mono: boolean;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const box = listRef.current;
    const el = box?.children[active] as HTMLElement | undefined;
    if (!el || !box) return;
    if (el.offsetTop < box.scrollTop) box.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = el.offsetTop + el.offsetHeight - box.clientHeight;
  }, [active]);

  return (
    <div
      className="anim-pop absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-xl border border-line-strong bg-raised/95 shadow-[0_16px_48px_-8px_rgba(0,0,0,0.55)] backdrop-blur-xl edge"
      data-state="open"
    >
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-steel">
        <span>{title}</span>
        <span className="flex items-center gap-1 font-normal normal-case tracking-normal">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          <Kbd>Tab</Kbd> to complete
        </span>
      </div>
      <ul ref={listRef} id="slash-menu" role="listbox" aria-label={title} className="max-h-[240px] overflow-y-auto p-1">
        {items.map((it, i) => (
          <li
            key={it.key}
            id={`suggest-${i}`}
            role="option"
            aria-selected={i === active}
            onMouseEnter={() => onHover(i)}
            // Keep focus in the textarea.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(i);
            }}
            className={cn(
              "flex cursor-default items-center gap-3 rounded-lg px-2.5 py-1.5",
              i === active && "bg-gunmetal/80",
            )}
          >
            <span className={cn("shrink-0 text-[12.5px] text-fg", mono ? "font-mono" : "")}>{it.label}</span>
            {it.detail && (
              <span
                className={cn("min-w-0 truncate text-[12px] text-muted", !mono && "font-mono text-[11px] text-steel")}
              >
                {it.detail}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResumeBanner({ agent }: { agent: Agent }) {
  const interrupted = agent.status === "interrupted";
  const [busy, setBusy] = useState(false);
  return (
    <div
      className={cn(
        "mb-2.5 flex items-center gap-3 rounded-xl border px-3.5 py-2.5",
        interrupted ? "border-violet/35 bg-violet/[0.08]" : "border-line-strong bg-card/70",
      )}
    >
      <span
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border",
          interrupted ? "border-violet/40 bg-violet/15 text-violet" : "border-line-strong bg-raised text-steel",
        )}
      >
        <RotateCcw className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{interrupted ? "Interrupted mid-turn" : "Agent shut down"}</div>
        <div className="truncate text-[12px] text-muted">
          {interrupted
            ? "The session is saved. Resume continues the turn from exactly where it stopped."
            : "The session is saved. Resume to reattach and keep chatting."}
        </div>
      </div>
      <Button
        size="sm"
        variant={interrupted ? "primary" : "secondary"}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await resumeAgent(agent);
          setBusy(false);
        }}
      >
        <Play className="!h-3.5 !w-3.5" />
        Resume
      </Button>
    </div>
  );
}

export const Composer = memo(ComposerImpl);
