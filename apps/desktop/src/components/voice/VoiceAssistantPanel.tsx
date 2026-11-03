import { ArrowUpRight, Check, Mic, MicOff, RefreshCw, RotateCcw, ShieldQuestion, Square, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { AssistantBilling } from "@/components/usage/BillingSummary";
import { describeScreen } from "@/lib/describeScreen";
import { tileIdsFor } from "@/lib/helpers";
import { formatCost, formatElapsed, isLive, PHASE_LABEL } from "@/lib/voiceAssistant";
import { cn, isEditableTarget, modKey } from "@/lib/utils";
import {
  answerVaConfirm,
  connectVoiceAssistant,
  escapeVoiceAssistant,
  resyncScreen,
  setVaMuted,
  stopVoiceAssistant,
  useVa,
} from "@/store/voiceAssistant";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { connectWakeStatus } from "@/store/wake";
import { TONE, VoiceOrb } from "./VoiceOrb";
import { usePanelDrag } from "./usePanelDrag";

/** Floating voice-assistant panel (bottom right). Mount once; it also owns the event subscription. */
export function VoiceAssistantPanel() {
  useEffect(() => connectVoiceAssistant(), []);
  // The wake phrase status is shared (the title-bar button and Settings show it): follow it from here too.
  useEffect(() => connectWakeStatus(), []);
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
  const notice = useVa((s) => s.notice);
  const confirms = useVa((s) => s.confirms);
  const dismiss = useVa((s) => s.dismiss);
  const openAgent = useUi((s) => s.openAgent);
  const live = isLive({ phase });
  const paused = phase === "paused";
  const level = phase === "speaking" ? outputLevel : inputLevel;
  const logRef = useRef<HTMLDivElement>(null);
  const { wrapRef, moved, reset, dragArea, gripKeys } = usePanelDrag();
  const confirming = live && confirms.length > 0;
  // The glow is a static shadow in the phase colour (never animated: it would repaint every frame).
  const tone = confirming ? TONE.listening : TONE[phase];
  const ring = confirming ? 55 : 22;

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
    <div
      ref={wrapRef}
      className="group/drag fixed bottom-[var(--composer-clear,1rem)] right-4 z-40 w-[360px] max-w-[calc(100vw-2rem)]"
      style={{ willChange: "transform" }}
    >
      <section
        role="region"
        aria-label="Voice assistant"
        className={cn(
          "view-enter texture relative flex flex-col overflow-hidden rounded-2xl border bg-panel",
          confirming ? "border-accent/60" : "border-line-strong",
        )}
        style={{
          backgroundImage: `radial-gradient(130% 90px at 24px 0, color-mix(in srgb, ${tone} 13%, transparent), transparent), linear-gradient(180deg, color-mix(in srgb, var(--bg-2) 70%, var(--bg-1)), var(--bg-1) 60%)`,
          boxShadow: `inset 0 1px 0 0 var(--edge-strong), 0 0 0 1px color-mix(in srgb, ${tone} ${ring}%, transparent), 0 18px 50px -12px rgba(0,0,0,0.6), 0 0 36px -8px color-mix(in srgb, ${tone} 28%, transparent)`,
        }}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-6 top-0 h-px opacity-60"
          style={{ background: `linear-gradient(90deg, transparent, ${tone}, transparent)` }}
        />
        <div
          {...dragArea}
          className="cursor-grab touch-none select-none group-data-[dragging=true]/drag:cursor-grabbing"
        >
          <div className="relative flex h-5 items-center justify-center">
            <Tooltip content="Drag to move. Double-click to put it back." side="top">
              <button
                type="button"
                data-grip
                aria-label="Move voice assistant"
                {...gripKeys}
                className="group flex h-5 w-20 cursor-grab items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
              >
                <span className="h-1 w-9 rounded-full bg-line-strong/60 transition-colors group-hover:bg-steel group-focus-visible:bg-accent" />
              </button>
            </Tooltip>
            {moved && (
              <Tooltip content="Put it back" side="top">
                <button
                  type="button"
                  aria-label="Reset position"
                  onClick={reset}
                  className="absolute right-2.5 top-1 inline-flex size-4 cursor-pointer items-center justify-center rounded text-steel transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/70"
                >
                  <RotateCcw className="size-3" />
                </button>
              </Tooltip>
            )}
          </div>
          <div className="flex items-center gap-3 px-4 pb-3.5 pt-0.5">
            <VoiceOrb phase={phase} level={level} size={48} />
            <div className="min-w-0 flex-1">
              <div
                className={cn("text-[14px] font-medium leading-[20px]", phase === "error" ? "text-err" : "text-fg")}
                role="status"
                aria-live="polite"
              >
                {confirming ? "Needs your OK" : phase === "off" ? "Ended" : PHASE_LABEL[phase]}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] leading-[16px] text-steel">
                {paused ? (
                  <span>Not listening. Nothing is sent.</span>
                ) : live ? (
                  <>
                    <span className="tabular">{formatElapsed(elapsed)}</span>
                    <span aria-hidden="true">·</span>
                    <Tooltip
                      content="Estimate from the usage OpenAI reports. Your OpenAI bill is what counts."
                      side="top"
                    >
                      <span className="tabular cursor-help">~{formatCost(cost)} est.</span>
                    </Tooltip>
                  </>
                ) : (
                  <span className="truncate">{message ?? "Session ended"}</span>
                )}
              </div>
            </div>
            {live ? (
              <div className="flex items-center gap-1">
                {paused ? (
                  <Button variant="warn" size="sm" onClick={() => setVaMuted(false)}>
                    <MicOff /> Unmute
                  </Button>
                ) : (
                  <Tooltip content="Mute (pause listening)" side="top">
                    <Button variant="ghost" size="sm" aria-label="Mute microphone" onClick={() => setVaMuted(true)}>
                      <Mic /> Mute
                    </Button>
                  </Tooltip>
                )}
                <Tooltip content="End (Esc)" side="top">
                  <Button
                    variant="danger"
                    size="sm"
                    aria-label="End voice assistant"
                    onClick={() => void stopVoiceAssistant()}
                  >
                    <Square className="!size-3 fill-current" /> End
                  </Button>
                </Tooltip>
              </div>
            ) : (
              <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={dismiss}>
                <X />
              </Button>
            )}
          </div>
        </div>

        {confirming && (
          <div
            className="space-y-2.5 border-t border-accent/40 bg-accent/[0.06] px-4 pb-4 pt-3"
            role="group"
            aria-label="Confirm action"
          >
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase leading-[16px] tracking-wide text-accent">
              <ShieldQuestion className="size-3.5" />
              Waiting for your OK{confirms.length > 1 ? ` (${confirms.length})` : ""}
            </div>
            {confirms.map((c, i) => (
              <div key={c.id} className="rounded-xl border border-accent/35 bg-base/60 p-3">
                <p className="selectable max-h-[120px] overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-accent/70 pl-2.5 text-[13px] leading-[19px] text-fg">
                  {c.summary}
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <Button variant="outline" size="lg" className="flex-1" onClick={() => answerVaConfirm(c.id, false)}>
                    Cancel
                    {i === 0 && <Kbd>Esc</Kbd>}
                  </Button>
                  <Button
                    variant="primary"
                    size="lg"
                    className="flex-[1.4]"
                    onClick={() => answerVaConfirm(c.id, true)}
                  >
                    <Check /> Confirm
                    {i === 0 && <Kbd dim>Enter</Kbd>}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        {notice && live && (
          <p
            role="status"
            className="border-t border-warn/25 bg-warn/[0.06] px-4 py-2 text-[12px] leading-[18px] text-warn"
          >
            {notice}
          </p>
        )}
        {live && <SeesRow />}
        {live && <AssistantBilling className="border-t border-line px-4 py-2.5" />}
        {(captions.length > 0 || actions.length > 0) && (
          <div
            ref={logRef}
            className="selectable max-h-[240px] space-y-1 overflow-y-auto border-t border-line bg-base/30 px-3.5 py-3"
          >
            {captions.map((c, i) => {
              const mine = c.role === "user";
              const first = i === 0 || captions[i - 1].role !== c.role;
              return (
                <div
                  key={`${c.role}-${c.itemId}`}
                  className={cn("flex flex-col", mine ? "items-end" : "items-start", first && i > 0 && "pt-1.5")}
                >
                  {first && (
                    <span className="mb-0.5 px-1 text-[10.5px] font-medium uppercase leading-[14px] tracking-wide text-steel">
                      {mine ? "You" : "Kvistcode"}
                    </span>
                  )}
                  <p
                    className={cn(
                      "max-w-[90%] break-words rounded-2xl border px-3 py-1.5 text-[12.5px] leading-[18px]",
                      mine
                        ? "rounded-br-md border-accent/25 bg-accent/12 text-fg"
                        : "rounded-bl-md border-line bg-card text-fg",
                      !c.done && "opacity-80",
                    )}
                  >
                    {c.text}
                  </p>
                </div>
              );
            })}
            {actions.length > 0 && (
              <ul className="space-y-1 pt-2" aria-label="Actions taken">
                {actions.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-start gap-2 rounded-lg border border-line bg-panel/80 px-2.5 py-1.5 text-[12px] leading-[18px] text-muted"
                  >
                    <span
                      className={cn(
                        "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full",
                        a.ok ? "bg-ok/15 text-ok" : "bg-err/15 text-err",
                      )}
                    >
                      {a.ok ? (
                        <Check className="size-2.5" strokeWidth={3} />
                      ) : (
                        <X className="size-2.5" strokeWidth={3} />
                      )}
                      <span className="sr-only">{a.ok ? "Done" : "Failed"}</span>
                    </span>
                    <span className="min-w-0 flex-1 break-words">{a.summary}</span>
                    {a.agentId && (
                      <button
                        type="button"
                        onClick={() => openAgent(a.agentId!)}
                        className="inline-flex h-[18px] shrink-0 items-center gap-0.5 rounded-full bg-accent/12 px-2 text-[11px] font-medium leading-[16px] text-accent transition-colors hover:bg-accent/20"
                      >
                        Open <ArrowUpRight className="size-3" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {paused && (
          <p className="border-t border-line px-4 py-2.5 text-[12px] leading-[18px] text-steel">
            Press Unmute or {modKey}+Shift+A to listen again. Kvistcode can't hear you while paused, so waking by voice
            isn't possible yet.
          </p>
        )}
        {live && captions.length === 0 && phase === "listening" && (
          <p className="border-t border-line px-4 py-2.5 text-[12px] leading-[18px] text-steel">
            Try “what are my agents doing?” or “start an agent in storefront to fix the flaky test”.
          </p>
        )}
      </section>
    </div>
  );
}

/** What the assistant sees right now (the open agent or the screen), and a button to send it again. */
function SeesRow() {
  const view = useUi((s) => s.view);
  const agentId = useUi((s) => (s.view === "agents" ? s.selectedAgentId : null));
  const tileGroup = useUi((s) => s.tileGroup);
  const tileHelpers = useUi((s) => s.tileHelpers);
  // Only the title, folder and grid size, so an agent that is streaming does not re-render this row.
  const title = useApp((s) => (agentId ? s.agents[agentId]?.title : undefined));
  const projectPath = useApp((s) => (agentId ? s.agents[agentId]?.projectPath : undefined));
  // The same agents the assistant is told are shown together (see `reportScreen`).
  const shownCount = useApp((s) => tileIdsFor(s.agents, agentId, tileGroup, tileHelpers).length);
  const seen = describeScreen(
    { view, agentId },
    agentId && title !== undefined ? { [agentId]: { title, projectPath: projectPath ?? "" } } : {},
    shownCount,
  );
  return (
    <div className="flex items-center gap-1.5 border-t border-line px-4 py-1.5 text-[11.5px] leading-[16px] text-steel">
      <span className="shrink-0">Sees:</span>
      <Tooltip content={seen.full} side="top">
        <span className="min-w-0 flex-1 cursor-default truncate text-fg">{seen.label}</span>
      </Tooltip>
      {seen.together && <span className="shrink-0">{seen.together}</span>}
      <Tooltip content="Send the screen to the assistant again" side="top">
        <Button variant="ghost" size="icon-sm" aria-label="Send the screen again" onClick={resyncScreen}>
          <RefreshCw />
        </Button>
      </Tooltip>
    </div>
  );
}

/** A small key hint inside a button. */
function Kbd({ children, dim }: { children: string; dim?: boolean }) {
  return (
    <kbd
      className={cn(
        "ml-1 rounded border px-1 font-sans text-[10.5px] font-medium leading-[16px]",
        dim ? "border-current/30 opacity-70" : "border-line-strong text-steel",
      )}
    >
      {children}
    </kbd>
  );
}
