import { ArrowUp, BookText, ChevronDown, FileText, GitFork, ListPlus, Play, RotateCcw, Square } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { cancelTurn, resumeAgent } from "@/lib/actions";
import { api } from "@/lib/api";
import { MAX_ATTACHMENTS } from "@/lib/attachments";
import { canStartHelper, decideBusySend, type BusyIntent } from "@/lib/helpers";
import type { Agent, SlashCommand, Attachment } from "@/lib/types";
import { cn, errorMessage, modKey } from "@/lib/utils";
import { useDebounced } from "@/hooks/useDebounced";
import { useElementWidth } from "@/hooks/useElementWidth";
import { useIdentity } from "@/hooks/useIdentity";
import { useAttachments } from "@/hooks/useAttachments";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { getDraft, onAttachmentsInsert, onDraftInsert, setDraft } from "./drafts";
import { AttachButton, DropOverlay } from "../AttachControls";
import { ComposerVoiceButtons } from "../voice/ComposerVoiceButtons";
import { AttachmentStrip } from "../AttachmentStrip";
import { TemplatePicker } from "../TemplatePicker";
import { Button } from "../ui/button";
import { useIsDone } from "@/store/completion";
import { Kbd } from "../ui/kbd";
import { Tooltip } from "../ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/menu";
import { ConfigOverflowMenu, ConfigSelect } from "./ConfigSelect";
import { QueueStack } from "./QueueStack";
import { RateLimitBanner } from "./RateLimitBanner";

const ESC_ARM_MS = 1500;

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

function ComposerImpl({ agent, focused = true }: { agent: Agent; focused?: boolean }) {
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
  const resumable = agent.status === "interrupted" || agent.status === "stopped";
  const busy = working || blocked;
  // Sending while the agent works queues the message; it runs right after this turn.
  const busySend = useApp((s) => s.settings?.busySend ?? "ask");
  const helperAllowed = canStartHelper(agent);
  const [chooser, setChooser] = useState(false);
  const canSend = !resumable && (text.trim().length > 0 || attach.attachments.length > 0) && !sending;

  const query = slashQuery(text);
  const matches = useMemo(() => {
    if (query === null) return [];
    return agent.availableCommands
      .filter((c) => c.name.toLowerCase().includes(query))
      .sort(
        (a, b) => Number(!a.name.toLowerCase().startsWith(query)) - Number(!b.name.toLowerCase().startsWith(query)),
      );
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
    setChooser(false);
  }, [agent.id]);
  // The turn ended while the chooser was open: a plain Enter sends now.
  useEffect(() => {
    if (!busy) setChooser(false);
  }, [busy]);

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

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [text]);

  const update = (v: string, nextCaret = v.length) => {
    setText(v);
    textRef.current = v;
    setCaret(nextCaret);
    setDraft(agent.id, v);
    if (escArmed) setEscArmed(false);
    if (chooser) setChooser(false);
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
          if (incoming.length > room) toast.warning(`Only ${MAX_ATTACHMENTS} images per message; some weren't attached`);
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

  /** Queue behind the current turn (or send, when the agent is idle). */
  const sendNow = async () => {
    if (!canSend) return;
    const value = text.trim();
    const images = attach.attachments;
    setSending(true);
    update("");
    attach.clear();
    setHint(null);
    try {
      await api.sendPrompt(agent.id, value, images);
    } catch (e) {
      update(value);
      attach.setAttachments(images);
      toast.error("Couldn't send prompt", { description: errorMessage(e) });
    } finally {
      setSending(false);
    }
  };

  /** Run the message in a new helper agent, in parallel with this one. */
  const startHelper = async () => {
    if (!canSend || !helperAllowed) return;
    const value = text.trim();
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
      update(value);
      attach.setAttachments(images);
      toast.error("Couldn't start a helper", { description: errorMessage(e) });
    } finally {
      setSending(false);
    }
  };

  /** One send gesture. While busy it queues, starts a helper, or asks, per setting and gesture. */
  const send = async (intent: BusyIntent = "enter") => {
    if (!canSend) return;
    if (busy) {
      if (chooser && intent === "queueButton") {
        setChooser(false);
        return;
      }
      const d = decideBusySend(busySend, intent, helperAllowed);
      if (d === "ask") {
        setChooser(true);
        return;
      }
      if (d === "helper") return void startHelper();
    }
    await sendNow();
  };

  /** A pick in the chooser; "remember" saves it as the default for every agent. */
  const choose = (choice: "queue" | "helper", remember: boolean) => {
    setChooser(false);
    if (remember) {
      void useApp
        .getState()
        .patchSettings({ busySend: choice })
        .catch((e) => toast.error("Couldn't save your choice", { description: errorMessage(e) }));
    }
    void (choice === "helper" ? startHelper() : sendNow());
    requestAnimationFrame(() => ref.current?.focus());
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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(e.metaKey || e.ctrlKey ? "modEnter" : "enter");
    } else if (e.key === "Escape" && chooser) {
      e.preventDefault();
      e.stopPropagation();
      setChooser(false);
    } else if (e.key === "Escape" && busy && text.trim() === "" && attach.attachments.length === 0) {
      e.preventDefault();
      onEscape();
    }
  };

  const name = useIdentity(agent.provider, agent.customAgentId).short;
  const justDone = useIsDone(agent);
  const placeholder = blocked
    ? `Waiting for your approval above. Queue a message to run after this turn…`
    : working
      ? `${name} is working. Queue a follow-up message…`
      : justDone
        ? `Done. Reply, or start something new…`
        : agent.availableCommands.length > 0
          ? `Message ${name}…  / for commands, @ for files`
          : `Message ${name}…  @ to mention files`;

  return (
    <div ref={wrapRef} data-dictation-scope className={cn("shrink-0 pb-4 pt-1", tight ? "px-3" : "px-6")}>
      <div className={cn("mx-auto w-full", width >= 1330 ? "max-w-[1000px]" : "max-w-[860px]")}>
        {agent.rateLimited && !resumable && <RateLimitBanner agent={agent} />}
        <QueueStack agent={agent} onEdit={takeBack} />
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
                  ? "Answer the approval above, or press Esc again to stop the turn"
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
            {chooser && busy && (
              <BusyChooser
                name={name}
                helperAllowed={helperAllowed}
                onChoose={choose}
                onClose={() => {
                  setChooser(false);
                  requestAnimationFrame(() => ref.current?.focus());
                }}
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
                aria-autocomplete="list"
                aria-expanded={slashOpen}
                aria-controls={slashOpen ? "slash-menu" : undefined}
                aria-activedescendant={slashOpen ? `suggest-${activeIndex}` : undefined}
                placeholder={placeholder}
                onChange={(e) => update(e.target.value, e.target.selectionStart ?? e.target.value.length)}
                onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
                onPaste={attach.onPaste}
                onKeyDown={onKeyDown}
                onBlur={() => setSlashDismissed(true)}
                onFocus={() => setSlashDismissed(false)}
                className="relative block max-h-[40vh] min-h-[52px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[13.5px] leading-relaxed text-fg placeholder:text-steel focus:outline-none"
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
                <span className={cn("mx-1.5 h-4 w-px bg-line", !busy && "hidden xl:block")} aria-hidden />
              </div>
              <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[11.5px] text-steel">
                {busy ? (
                  <>
                    <span className="relative flex h-2 w-2 shrink-0">
                      <span
                        className={cn(
                          "absolute inset-0 rounded-full animate-pulse-ring",
                          blocked ? "bg-warn" : "bg-accent",
                        )}
                      />
                      <span className={cn("relative h-2 w-2 rounded-full", blocked ? "bg-warn" : "bg-accent")} />
                    </span>
                    <span className={cn("whitespace-nowrap", width > 0 && width < 600 && "sr-only")}>
                      {blocked ? "Waiting for approval" : "Working…"}
                    </span>
                  </>
                ) : (
                  <span className="hidden items-center gap-1 xl:flex">
                    <Kbd>⏎</Kbd> send <span className="mx-1 text-line-strong">·</span> <Kbd>⇧</Kbd>
                    <Kbd>⏎</Kbd> newline
                  </span>
                )}
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                <ComposerVoiceButtons onText={insertDictation} />
                {busy && (
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
                {busy ? (
                  <div data-busy-send className="flex items-center">
                    <Tooltip
                      content={
                        busySend === "helper" && helperAllowed
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
                          busySend === "helper" && helperAllowed
                            ? "Start a helper with this message"
                            : "Queue message (runs after the current turn)"
                        }
                        className={cn("rounded-lg", helperAllowed && "rounded-r-none")}
                      >
                        {busySend === "helper" && helperAllowed ? (
                          <GitFork className="!h-4 !w-4" />
                        ) : (
                          <ListPlus className="!h-4 !w-4" />
                        )}
                        {!tight && (busySend === "helper" && helperAllowed ? "Helper" : "Queue")}
                      </Button>
                    </Tooltip>
                    {helperAllowed && (
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
                          {busySend === "helper" ? (
                            <DropdownMenuItem disabled={!canSend} onSelect={() => void send("queueMenu")}>
                              <ListPlus /> Queue for {name} instead
                              <span className="ml-auto pl-4 text-[11px] text-steel">after this turn</span>
                            </DropdownMenuItem>
                          ) : (
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
                    )}
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

/**
 * Asked when you send while the agent works and the setting is "Ask": queue behind the turn, or
 * start a helper that runs now. Keyboard-first (Q / H / ⏎ / Esc); focus stays inside until closed.
 */
function BusyChooser({
  name,
  helperAllowed,
  onChoose,
  onClose,
}: {
  name: string;
  helperAllowed: boolean;
  onChoose: (choice: "queue" | "helper", remember: boolean) => void;
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<"queue" | "helper">("queue");
  const [remember, setRemember] = useState(false);
  useEffect(() => boxRef.current?.focus(), []);
  const options = [
    {
      id: "queue" as const,
      icon: <ListPlus className="h-4 w-4" />,
      title: `Queue for ${name}`,
      detail: "Runs right after the current turn",
      keys: ["Q"],
    },
    ...(helperAllowed
      ? [
          {
            id: "helper" as const,
            icon: <GitFork className="h-4 w-4" />,
            title: "Start a helper now",
            detail: "Works in parallel, then merges back",
            keys: [modKey, "⏎"],
          },
        ]
      : []),
  ];
  return (
    <div
      ref={boxRef}
      tabIndex={-1}
      role="dialog"
      aria-label="Send while busy"
      data-busy-send
      data-state="open"
      onBlur={(e) => {
        const next = e.relatedTarget as HTMLElement | null;
        if (!next || (!e.currentTarget.contains(next) && !next.closest("[data-busy-send]"))) onClose();
      }}
      onKeyDown={(e) => {
        if (composing(e)) return;
        // Holding Enter in the composer repeats into the chooser: that must not pick for you.
        if (e.repeat) return e.preventDefault();
        const k = e.key.toLowerCase();
        // Browser/OS chords (Ctrl+R reload, Ctrl+Q quit, ...) are not choices; only Enter takes a modifier.
        if ((e.metaKey || e.ctrlKey || e.altKey) && e.key !== "Enter") return;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (k === "q") {
          e.preventDefault();
          onChoose("queue", remember);
        } else if ((k === "h" && helperAllowed) || (e.key === "Enter" && (e.metaKey || e.ctrlKey) && helperAllowed)) {
          e.preventDefault();
          onChoose("helper", remember);
        } else if (e.key === "Enter") {
          e.preventDefault();
          onChoose(active, remember);
        } else if (k === "r") {
          e.preventDefault();
          setRemember((v) => !v);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Tab") {
          e.preventDefault();
          if (options.length > 1) setActive((a) => (a === "queue" ? "helper" : "queue"));
        }
      }}
      className="anim-pop absolute bottom-full right-0 z-20 mb-2 w-[min(400px,100%)] overflow-hidden rounded-xl border border-line-strong bg-raised/95 shadow-[0_16px_48px_-8px_rgba(0,0,0,0.55)] outline-none backdrop-blur-xl edge"
    >
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-steel">
        <span>{name} is working</span>
        <span className="flex items-center gap-1 font-normal normal-case tracking-normal">
          <Kbd>Esc</Kbd> keeps your draft
        </span>
      </div>
      <ul
        role="listbox"
        aria-label="What should happen to this message?"
        aria-activedescendant={`busy-send-${active}`}
        className="p-1"
      >
        {options.map((o) => (
          <li
            key={o.id}
            id={`busy-send-${o.id}`}
            role="option"
            aria-selected={o.id === active}
            onMouseEnter={() => setActive(o.id)}
            onMouseDown={(e) => {
              e.preventDefault();
              onChoose(o.id, remember);
            }}
            className={cn(
              "flex cursor-default items-center gap-3 rounded-lg px-2.5 py-2",
              o.id === active && "bg-gunmetal/80",
            )}
          >
            <span
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border",
                o.id === "helper"
                  ? "border-accent/35 bg-accent/10 text-accent"
                  : "border-line-strong bg-card text-muted",
              )}
            >
              {o.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-fg">{o.title}</span>
              <span className="block truncate text-[11.5px] text-steel">{o.detail}</span>
            </span>
            <span className="flex shrink-0 items-center gap-0.5">
              {o.keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
              {o.id === active && o.id === "queue" && <Kbd className="ml-1">⏎</Kbd>}
            </span>
          </li>
        ))}
      </ul>
      <label
        className="flex cursor-pointer items-center gap-2 border-t border-line px-3 py-2 text-[12px] text-muted hover:text-fg"
        onMouseDown={(e) => e.preventDefault()}
      >
        <input
          type="checkbox"
          tabIndex={-1}
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          className="h-3.5 w-3.5 accent-[var(--accent)]"
        />
        Remember my choice
        <Kbd className="ml-auto">R</Kbd>
      </label>
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
