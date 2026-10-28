import { ArrowUp, FileText, Play, RotateCcw, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { cancelTurn, resumeAgent } from "@/lib/actions";
import { api } from "@/lib/api";
import type { Agent, SlashCommand } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { useDebounced } from "@/hooks/useDebounced";
import { useIdentity } from "@/hooks/useIdentity";
import { useAttachments } from "@/hooks/useAttachments";
import { useUi } from "@/store/ui";
import { AttachButton, DropOverlay } from "../AttachControls";
import { AttachmentStrip } from "../AttachmentStrip";
import { TemplatePicker } from "../TemplatePicker";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { ConfigSelect } from "./ConfigSelect";
import { RateLimitBanner } from "./RateLimitBanner";

const drafts = new Map<string, string>();

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

export function Composer({ agent }: { agent: Agent }) {
  const [text, setText] = useState(() => drafts.get(agent.id) ?? "");
  const [sending, setSending] = useState(false);
  const [hint, setHint] = useState<{ prefix: string; hint: string } | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [caret, setCaret] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const attach = useAttachments();
  const ref = useRef<HTMLTextAreaElement>(null);
  const focusTick = useUi((s) => s.composerFocusTick);

  const working = agent.status === "working" || agent.status === "starting";
  const blocked = agent.status === "needs_permission";
  const resumable = agent.status === "interrupted" || agent.status === "stopped";
  const busy = working || blocked;
  const canSend = !busy && !resumable && (text.trim().length > 0 || attach.attachments.length > 0) && !sending;

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
      setFiles([]);
      return;
    }
    let cancelled = false;
    api
      .listFiles(agent.id, debouncedMention)
      .then((f) => !cancelled && setFiles(f))
      .catch(() => !cancelled && setFiles([]));
    return () => {
      cancelled = true;
    };
  }, [agent.id, debouncedMention]);

  const mode: "slash" | "mention" | null = slashDismissed
    ? null
    : matches.length > 0
      ? "slash"
      : mention !== null && files.length > 0
        ? "mention"
        : null;
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
        ? files.slice(0, 50).map((f) => {
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

  // Per-agent drafts survive switching agents.
  useEffect(() => {
    setText(drafts.get(agent.id) ?? "");
    setHint(null);
  }, [agent.id]);

  useEffect(() => {
    if (!resumable) ref.current?.focus();
  }, [agent.id, focusTick, resumable]);

  useEffect(() => setSlashIndex(0), [query, debouncedMention, mode]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [text]);

  const update = (v: string, nextCaret = v.length) => {
    setText(v);
    setCaret(nextCaret);
    if (v) drafts.set(agent.id, v);
    else drafts.delete(agent.id);
    if (hint && v !== hint.prefix) setHint(null);
    if (slashQuery(v) === null && mentionQuery(v, nextCaret) === null) setSlashDismissed(false);
  };

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
    if (mode === "slash") pickCommand(matches[i]);
    else if (mode === "mention" && files[i]) pickFile(files[i]);
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

  const send = async () => {
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

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setSlashIndex((i) => (i + d + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pick(slashIndex);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setSlashDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    } else if (e.key === "Escape" && busy) {
      e.preventDefault();
      void cancelTurn(agent);
    }
  };

  const name = useIdentity(agent.provider, agent.customAgentId).short;
  const placeholder = blocked
    ? `${name} is waiting for your approval above`
    : working
      ? `${name} is working…`
      : agent.availableCommands.length > 0
        ? `Message ${name}…  / for commands, @ for files`
        : `Message ${name}…  @ to mention files`;

  return (
    <div className="shrink-0 px-6 pb-4 pt-1">
      <div className="mx-auto w-full max-w-[860px]">
        {agent.rateLimited && !resumable && <RateLimitBanner agent={agent} />}
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
            <input {...attach.inputProps} />
            {slashOpen && mode && (
              <SuggestMenu
                title={mode === "slash" ? `${name} commands` : "Files"}
                items={suggestions}
                active={slashIndex}
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
                aria-autocomplete="list"
                aria-expanded={slashOpen}
                aria-controls={slashOpen ? "slash-menu" : undefined}
                aria-activedescendant={slashOpen ? `suggest-${slashIndex}` : undefined}
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
                {agent.configOptions.map((opt) => (
                  <ConfigSelect key={opt.id} agent={agent} option={opt} />
                ))}
                <AttachButton onClick={attach.openPicker} count={attach.attachments.length} />
                <TemplatePicker onInsert={insertTemplate} />
                <span className={cn("mx-1.5 h-4 w-px bg-line", !busy && "hidden xl:block")} aria-hidden />
              </div>
              <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-steel">
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
                    <span className="truncate">{blocked ? "Waiting for approval" : `${name} is working…`}</span>
                    <span className="hidden items-center gap-1 xl:flex">
                      <Kbd>Esc</Kbd> to cancel
                    </span>
                  </>
                ) : (
                  <span className="hidden items-center gap-1 xl:flex">
                    <Kbd>⏎</Kbd> send <span className="mx-1 text-line-strong">·</span> <Kbd>⇧</Kbd>
                    <Kbd>⏎</Kbd> newline
                  </span>
                )}
              </div>
              <div className="ml-auto flex items-center gap-1.5">
                {busy ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void cancelTurn(agent)}
                    aria-label="Stop the current turn"
                    className="gap-1.5"
                  >
                    <Square className="!h-3 !w-3 fill-current" />
                    Stop
                  </Button>
                ) : (
                  <Button
                    size="icon-sm"
                    variant="primary"
                    disabled={!canSend}
                    onClick={() => void send()}
                    aria-label="Send"
                    className="rounded-lg"
                  >
                    <ArrowUp className="!h-4 !w-4" strokeWidth={2.5} />
                  </Button>
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
        <div className="text-[13px] font-medium">{interrupted ? "Interrupted mid-turn" : "Agent stopped"}</div>
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
