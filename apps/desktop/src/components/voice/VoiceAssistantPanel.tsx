import { ArrowUpRight, Mic, MicOff, Square, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { formatCost, formatElapsed, isLive, PHASE_LABEL } from "@/lib/voiceAssistant";
import { cn, isEditableTarget } from "@/lib/utils";
import {
  answerVaConfirm,
  connectVoiceAssistant,
  escapeVoiceAssistant,
  setVaMuted,
  stopVoiceAssistant,
  useVa,
} from "@/store/voiceAssistant";
import { useUi } from "@/store/ui";
import { VoiceOrb } from "./VoiceOrb";

/** Floating voice-assistant panel (bottom right). Mount once; it also owns the event subscription. */
export function VoiceAssistantPanel() {
  useEffect(() => connectVoiceAssistant(), []);
  const visible = useVa((s) => s.visible);
  const phase = useVa((s) => s.phase);
  if (!visible) return null;
  return <PanelBody key={phase === "error" ? "error" : "live"} />;
}

function PanelBody() {
  const phase = useVa((s) => s.phase);
  const message = useVa((s) => s.message);
  const inputLevel = useVa((s) => s.inputLevel);
  const outputLevel = useVa((s) => s.outputLevel);
  const captions = useVa((s) => s.captions);
  const actions = useVa((s) => s.actions);
  const elapsed = useVa((s) => s.elapsedSecs);
  const cost = useVa((s) => s.costUsd);
  const muted = useVa((s) => s.muted);
  const notice = useVa((s) => s.notice);
  const confirms = useVa((s) => s.confirms);
  const dismiss = useVa((s) => s.dismiss);
  const openAgent = useUi((s) => s.openAgent);
  const live = isLive({ phase });
  const level = phase === "speaking" ? outputLevel : inputLevel;
  const logRef = useRef<HTMLDivElement>(null);

  const firstConfirm = confirms[0]?.id ?? null;

  // Enter confirms and Esc cancels the pending action; otherwise Esc ends the session
  // (unless something else, like the composer, wants the key).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key !== "Escape" && e.key !== "Enter") return;
      // Typing somewhere keeps its keys, except in an empty field where they'd do nothing.
      const t = e.target;
      const emptyField = (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && t.value === "";
      if (isEditableTarget(t) && !(firstConfirm && emptyField)) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      if (e.key === "Enter") {
        // A focused button or link handles Enter itself.
        if (!firstConfirm || (e.target instanceof Element && e.target.closest("button, a, [role='button']"))) return;
        e.preventDefault();
        answerVaConfirm(firstConfirm, true);
        return;
      }
      e.preventDefault();
      if (firstConfirm) answerVaConfirm(firstConfirm, false);
      else void escapeVoiceAssistant();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [firstConfirm]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [captions, actions]);

  return (
    <section
      role="region"
      aria-label="Voice assistant"
      className="view-enter texture edge fixed bottom-[var(--composer-clear,1rem)] right-4 z-40 flex w-[340px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-line-strong bg-panel shadow-[0_18px_50px_-12px_rgba(0,0,0,0.6)]"
    >
      <div className="flex items-center gap-3.5 px-4 pb-3 pt-4">
        <VoiceOrb phase={phase} level={level} muted={muted} />
        <div className="min-w-0 flex-1">
          <div
            className={cn("text-[13.5px] font-medium", phase === "error" ? "text-err" : "text-fg")}
            role="status"
            aria-live="polite"
          >
            {phase === "off" ? "Ended" : muted && phase === "listening" ? "Muted" : PHASE_LABEL[phase]}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-steel">
            {live ? (
              <>
                <span className="tabular">{formatElapsed(elapsed)}</span>
                <span aria-hidden="true">·</span>
                <Tooltip content="Estimate from the usage OpenAI reports. Your OpenAI bill is what counts." side="top">
                  <span className="tabular cursor-help">~{formatCost(cost)} est.</span>
                </Tooltip>
              </>
            ) : (
              <span>{message ?? "Session ended"}</span>
            )}
          </div>
        </div>
        {live ? (
          <div className="flex items-center gap-1">
            <Tooltip content={muted ? "Unmute microphone" : "Mute microphone"} side="top">
              <Button
                variant={muted ? "warn" : "ghost"}
                size="icon-sm"
                aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                aria-pressed={muted}
                onClick={() => setVaMuted(!muted)}
              >
                {muted ? <MicOff /> : <Mic />}
              </Button>
            </Tooltip>
            <Tooltip content="End (Esc)" side="top">
              <Button
                variant="danger"
                size="icon-sm"
                aria-label="End voice assistant"
                onClick={() => void stopVoiceAssistant()}
              >
                <Square className="!size-3 fill-current" />
              </Button>
            </Tooltip>
          </div>
        ) : (
          <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={dismiss}>
            <X />
          </Button>
        )}
      </div>

      {notice && live && (
        <p role="status" className="border-t border-line px-4 py-2 text-[12px] text-warn">
          {notice}
        </p>
      )}
      {live && confirms.length > 0 && (
        <div className="space-y-2 border-t border-line px-4 py-3" role="group" aria-label="Confirm action">
          {confirms.map((c, i) => (
            <div key={c.id} className="rounded-lg border border-accent/40 bg-accent/5 p-2.5">
              <p className="max-h-[120px] overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-fg">
                {c.summary}
              </p>
              <div className="mt-2 flex items-center justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => answerVaConfirm(c.id, false)}>
                  Cancel{i === 0 && <span className="ml-1 text-[10.5px] text-steel">Esc</span>}
                </Button>
                <Button size="sm" onClick={() => answerVaConfirm(c.id, true)}>
                  Confirm{i === 0 && <span className="ml-1 text-[10.5px] opacity-70">Enter</span>}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {(captions.length > 0 || actions.length > 0) && (
        <div ref={logRef} className="max-h-[220px] space-y-2 overflow-y-auto border-t border-line px-4 py-3">
          {captions.map((c) => (
            <p
              key={`${c.role}-${c.itemId}`}
              className={cn(
                "text-[12.5px] leading-relaxed",
                c.role === "user" ? "text-muted" : "text-fg",
                !c.done && "opacity-80",
              )}
            >
              <span className="mr-1.5 text-[10.5px] font-medium uppercase tracking-wide text-steel">
                {c.role === "user" ? "You" : "Armada"}
              </span>
              {c.text}
            </p>
          ))}
          {actions.length > 0 && (
            <ul className="space-y-1 pt-1" aria-label="Actions taken">
              {actions.map((a) => (
                <li
                  key={a.id}
                  className="flex items-start gap-2 rounded-lg border border-line bg-base/50 px-2.5 py-1.5 text-[12px] text-muted"
                >
                  <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", a.ok ? "bg-ok" : "bg-err")} />
                  <span className="min-w-0 flex-1 break-words">{a.summary}</span>
                  {a.agentId && (
                    <button
                      type="button"
                      onClick={() => openAgent(a.agentId!)}
                      className="inline-flex shrink-0 items-center gap-0.5 text-accent hover:underline"
                    >
                      Open <ArrowUpRight className="h-3 w-3" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {live && captions.length === 0 && phase === "listening" && (
        <p className="border-t border-line px-4 py-2.5 text-[12px] text-steel">
          Try “what are my agents doing?” or “start an agent in storefront to fix the flaky test”.
        </p>
      )}
    </section>
  );
}
