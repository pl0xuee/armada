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
import { cn } from "@/lib/utils";
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
  className,
}: {
  onText: (text: string, autoSend: boolean) => void;
  iconOnly?: boolean;
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
        <ActiveDictate id={id} phase={phase} className={className} />
      ) : (
        <IdleDictate id={id} phase={phase} iconOnly={iconOnly} className={className} />
      )}
    </span>
  );
}

function ActiveDictate({ id, phase, className }: { id: string; phase: DictationPhase; className?: string }) {
  const level = useDictation((s) => s.level);
  const elapsedMs = useDictation((s) => s.elapsedMs);
  const maxMs = useDictation((s) => s.maxMs);

  if (phase === "transcribing") {
    return (
      <span
        className={cn("inline-flex h-6 items-center gap-1.5 px-1.5 text-[11.5px] text-muted", className)}
        role="status"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Transcribing…
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
            "inline-flex h-6 items-center gap-1.5 rounded-md border border-err/30 bg-err/12 pl-1.5 pr-2 text-[11.5px] text-err transition-colors hover:bg-err/20",
            className,
          )}
        >
          <Square className="h-2.5 w-2.5 fill-current" />
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
  className,
}: {
  id: string;
  phase: DictationPhase;
  iconOnly?: boolean;
  className?: string;
}) {
  return (
    <>
      <Tooltip content="Dictate (speech to text, on this device)" shortcut={DICTATION_KEYS}>
        <button
          type="button"
          onClick={() => void toggleDictation(id)}
          disabled={phase !== "idle"}
          aria-label="Dictate a message"
          className={cn(
            "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-40",
            className,
          )}
        >
          <Mic className="h-3.5 w-3.5" />
          {!iconOnly && <span>Dictate</span>}
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
