import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { cancelTurn, sendPrompt } from "@/lib/controller";
import { cn } from "@/lib/cn";
import { agentIdentity, isBusy } from "@/lib/meta";
import { storage } from "@/lib/storage";
import { useStore } from "@/lib/store";
import type { Agent } from "@/lib/types";
import { Icon, Spinner } from "./Icon";

const MAX_HEIGHT = 168;
const draftKey = (agentId: string) => `armada.draft.${agentId}`;

export function loadDraft(agentId: string) {
  return storage.get(draftKey(agentId)) ?? "";
}

/**
 * Sticky prompt box. Enter inserts a newline on touch keyboards and sends
 * with a hardware keyboard (Shift+Enter for a newline); Ctrl/⌘+Enter always
 * sends. Drafts survive reloads per agent.
 */
export function Composer({
  agent,
  value,
  onChange,
  banner,
}: {
  agent: Agent;
  value: string;
  onChange: (v: string) => void;
  banner?: ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const customAgents = useStore((s) => s.customAgents);
  const cancelling = useStore((s) => !!s.busy[`cancel:${agent.id}`]);
  const busy = isBusy(agent.status);
  const name = agentIdentity(agent, customAgents).short;
  const canSend = value.trim().length > 0;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [value]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (value.trim()) storage.set(draftKey(agent.id), value);
      else storage.remove(draftKey(agent.id));
    }, 300);
    return () => clearTimeout(t);
  }, [agent.id, value]);

  const send = useCallback(() => {
    const text = value.trim();
    if (!text) return;
    onChange("");
    storage.remove(draftKey(agent.id));
    void sendPrompt(agent.id, text);
    // Keep the keyboard up on phones so follow-ups are quick.
    ref.current?.focus({ preventScroll: true });
  }, [agent.id, onChange, value]);

  return (
    <div className="chrome sticky bottom-0 z-20 border-t border-line/70 pb-[max(10px,var(--safe-bottom))]">
      {banner}
      <form
        className="mx-auto flex w-full max-w-[860px] items-end gap-2 px-safe pt-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <label className="sr-only" htmlFor={`composer-${agent.id}`}>
          Message {name}
        </label>
        <div className="flex min-h-12 min-w-0 flex-1 items-center rounded-[22px] border border-line-strong bg-card px-4 py-[9px] transition-colors duration-150 focus-within:border-accent/60 edge">
          <textarea
            id={`composer-${agent.id}`}
            ref={ref}
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              const fine = window.matchMedia("(pointer: fine)").matches;
              if (e.metaKey || e.ctrlKey || (fine && !e.shiftKey)) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={busy ? `Follow up with ${name}…` : `Message ${name}…`}
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
            aria-label="Send"
            className={cn(
              "press inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full transition-colors duration-150",
              canSend ? "bg-accent text-accent-fg shadow-[0_6px_18px_-6px_var(--accent)]" : "bg-raised text-steel",
            )}
          >
            <Icon name="arrowUp" size={22} strokeWidth={2.2} />
          </button>
        )}
      </form>
    </div>
  );
}
