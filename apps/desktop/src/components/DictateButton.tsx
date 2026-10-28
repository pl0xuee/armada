import { Download, Loader2, Mic, Square } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { useVoiceModelDownload } from "@/hooks/useVoiceModelDownload";
import { api } from "@/lib/api";
import {
  DICTATION_KEYS,
  dictationAvailable,
  registerDictationTarget,
  type DictationPhase,
  toggleDictation,
  useDictation,
} from "@/lib/dictation";
import { formatBytes } from "@/lib/format";
import type { VoiceModel } from "@/lib/types";
import { cn, isMac, modKey } from "@/lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "./ui/dialog";
import { Tooltip } from "./ui/tooltip";

const BAR_GAIN = [0.55, 0.9, 1, 0.75, 0.5];

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Mic button for a composer. Click (or the shortcut) to start, click / Enter to stop and
 * transcribe, Esc to cancel. `onText` gets the transcript to insert at the caret.
 */
export function DictateButton({
  onText,
  iconOnly,
  round,
  className,
}: {
  onText: (text: string, autoSend: boolean) => void;
  iconOnly?: boolean;
  /** Round 28px composer-side button (icon only; the recording state widens into a pill). */
  round?: boolean;
  className?: string;
}) {
  const id = useId();
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const anchor = useRef<HTMLSpanElement>(null);
  useEffect(
    () => registerDictationTarget({ id, insert: (t, a) => onTextRef.current(t, a), el: () => anchor.current }),
    [id],
  );

  const phase = useDictation((s) => s.phase);
  const mine = useDictation((s) => s.owner === id);
  const active = mine && phase !== "idle";
  // Only the recording button needs the 20 Hz level/clock; idle buttons skip those re-renders.
  if (!dictationAvailable()) return null;
  return (
    <span ref={anchor} className="contents">
      {active ? (
        <ActiveDictate id={id} phase={phase} round={round} className={className} />
      ) : (
        <IdleDictate id={id} phase={phase} iconOnly={iconOnly} round={round} className={className} />
      )}
    </span>
  );
}

function ActiveDictate({
  id,
  phase,
  round,
  className,
}: {
  id: string;
  phase: DictationPhase;
  round?: boolean;
  className?: string;
}) {
  const level = useDictation((s) => s.level);
  const elapsedMs = useDictation((s) => s.elapsedMs);
  const maxMs = useDictation((s) => s.maxMs);

  if (phase === "transcribing") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 text-[11.5px] text-muted",
          round ? "h-7 w-7 shrink-0 justify-center rounded-full border border-line-strong bg-raised" : "h-6 px-1.5",
          className,
        )}
        role="status"
        title="Transcribing…"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span className={round ? "sr-only" : undefined}>Transcribing…</span>
      </span>
    );
  }

  {
    const nearLimit = elapsedMs > maxMs - 30_000;
    return (
      <Tooltip content="Stop and transcribe (Enter). Esc cancels." shortcut={DICTATION_KEYS}>
        <button
          type="button"
          onClick={() => void toggleDictation(id)}
          aria-label="Stop dictation and transcribe"
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 border border-err/30 bg-err/12 text-[11.5px] text-err transition-colors hover:bg-err/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-err",
            round ? "h-7 rounded-full pl-2.5 pr-3" : "h-6 rounded-md pl-1.5 pr-2",
            className,
          )}
        >
          <Square className={cn("h-2.5 w-2.5 fill-current", round && "animate-pulse motion-reduce:animate-none")} />
          <span className="flex h-3.5 items-center gap-[2px]" aria-hidden>
            {BAR_GAIN.map((g, i) => (
              <span
                key={i}
                className="w-[2px] rounded-full bg-current transition-[height] duration-75"
                style={{ height: `${Math.round(3 + Math.min(1, level * g * 1.4) * 11)}px` }}
              />
            ))}
          </span>
          <span className={cn("tabular", nearLimit && "font-medium")}>
            {phase === "starting" ? "…" : clock(elapsedMs)}
          </span>
        </button>
      </Tooltip>
    );
  }
}

function IdleDictate({
  id,
  phase,
  iconOnly,
  round,
  className,
}: {
  id: string;
  phase: DictationPhase;
  iconOnly?: boolean;
  round?: boolean;
  className?: string;
}) {
  return (
    <>
      <Tooltip
        content={round ? "Dictate · on-device" : "Dictate (speech to text, on this device)"}
        shortcut={round ? [modKey, "⇧", "D"] : DICTATION_KEYS}
      >
        <button
          type="button"
          onClick={() => void toggleDictation(id)}
          disabled={phase !== "idle"}
          aria-label={round ? `Dictate, on-device (${modKey}+Shift+D)` : "Dictate a message"}
          aria-keyshortcuts={isMac ? "Meta+Shift+D" : "Control+Shift+D"}
          className={cn(
            "inline-flex items-center gap-1 text-[11.5px] text-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-40",
            round
              ? "h-7 w-7 shrink-0 justify-center rounded-full border border-line-strong bg-raised/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              : "h-6 rounded-md px-1.5",
            className,
          )}
        >
          <Mic className="h-3.5 w-3.5" />
          {!iconOnly && !round && <span>Dictate</span>}
        </button>
      </Tooltip>
    </>
  );
}

/** The one-time "download a speech model" prompt. Rendered once, near the app root. */
export function VoiceSetupDialog() {
  const open = useDictation((s) => s.setupOpen);
  const setOpen = useDictation((s) => s.setSetupOpen);
  const [model, setModel] = useState<VoiceModel | null>(null);

  useEffect(() => {
    if (!open) return;
    void api
      .voiceStatus()
      .then((s) => setModel(s.models.find((m) => m.id === s.model) ?? s.models.find((m) => m.isDefault) ?? null));
  }, [open]);

  const dl = useVoiceModelDownload(() => {
    setOpen(false);
    toast.success("Dictation is ready", { description: "Click the mic again to start speaking." });
  });
  const downloading = dl.active !== null;
  const pct = dl.active ? Math.min(100, Math.round((dl.active.done / Math.max(1, dl.active.total)) * 100)) : 0;

  return (
    <Dialog open={open} onOpenChange={(o) => (downloading ? undefined : setOpen(o))}>
      <DialogContent
        title="Set up voice dictation"
        description="Speak instead of typing. Everything is transcribed on this device."
        className="w-[min(460px,calc(100vw-32px))]"
      >
        <DialogBody className="space-y-3 text-[12.5px] text-muted">
          <p>
            Armada needs to download a speech model once
            {model ? (
              <>
                : <span className="text-fg">{model.label}</span> ({formatBytes(model.sizeBytes)}).
              </>
            ) : (
              "."
            )}{" "}
            It is saved in Armada's data folder and checked against a known checksum. Your audio never leaves this
            computer and is never saved.
          </p>
          <p>You can pick a different model, a language or a microphone in Settings.</p>
          {downloading && (
            <div className="space-y-1.5" role="status" aria-live="polite">
              <div className="h-1.5 overflow-hidden rounded-full bg-raised">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-150"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="tabular text-[11.5px] text-steel">
                Downloading… {pct}%
                {dl.active &&
                  dl.active.total > 1 &&
                  ` (${formatBytes(dl.active.done)} of ${formatBytes(dl.active.total)})`}
              </div>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          {downloading ? (
            <Button variant="ghost" size="sm" onClick={dl.cancel}>
              Cancel download
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Not now
              </Button>
              <Button variant="primary" size="sm" disabled={!model} onClick={() => model && void dl.start(model.id)}>
                <Download className="h-3.5 w-3.5" />
                Download{model ? ` (${formatBytes(model.sizeBytes)})` : ""}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
