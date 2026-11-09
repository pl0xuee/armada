import { Download, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { useVoiceModelDownload } from "@/hooks/useVoiceModelDownload";
import type { VoiceAssistantSettings } from "@/lib/types";
import { cn } from "@/lib/utils";
import { WAKE_MODEL, WAKE_PHRASE_MAX, wakeLine, wakePhraseProblem } from "@/lib/wakePhrase";
import { refreshWakeStatus, useWake } from "@/store/wake";
import { SettingGroup, SettingRow } from "./SettingRow";
import { useCommitOnUnmount } from "./useCommitOnUnmount";

/** Settings → Voice assistant: start (or wake) the assistant by saying a phrase. */
export function WakePhraseGroup({
  va,
  update,
}: {
  va: VoiceAssistantSettings;
  update: (patch: Partial<VoiceAssistantSettings>) => Promise<boolean>;
}) {
  const [phrase, setPhrase] = useState(va.wakePhrase);
  // Say nothing about a half-typed phrase until the person leaves the field.
  const [touched, setTouched] = useState(false);
  useEffect(() => setPhrase(va.wakePhrase), [va.wakePhrase]);

  const problem = touched ? wakePhraseProblem(phrase) : null;
  const commit = () => {
    setTouched(true);
    if (wakePhraseProblem(phrase) !== null) return;
    const next = phrase.trim().replace(/\s+/g, " ");
    setPhrase(next);
    if (next !== va.wakePhrase) void update({ wakePhrase: next });
  };
  useCommitOnUnmount(commit);

  return (
    <SettingGroup
      title="Wake phrase"
      description="Your microphone stays on while it listens, so your system may show a microphone indicator."
    >
      <SettingRow
        title="Start with a wake phrase"
        description="Say the phrase to start the assistant, or to wake it when it is paused. It listens on this computer; nothing is sent until it hears the phrase."
        htmlFor="va-wake"
      >
        <Switch id="va-wake" checked={va.wakeWord} onCheckedChange={(on) => void update({ wakeWord: on })} />
      </SettingRow>
      <SettingRow
        title="Phrase"
        description="Two to five words. Say anything after it and the assistant starts on that, like “Hey Kvistcode, what are my agents doing?”"
        htmlFor="va-wake-phrase"
      >
        <div className="flex max-w-full flex-col items-end gap-1.5">
          <Input
            id="va-wake-phrase"
            className={cn("h-8 w-[220px] max-w-full", problem && "border-err/60 focus:border-err/70 focus:ring-err/15")}
            value={phrase}
            maxLength={WAKE_PHRASE_MAX}
            aria-invalid={!!problem}
            aria-describedby={problem ? "va-wake-phrase-error" : undefined}
            onChange={(e) => setPhrase(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setPhrase(va.wakePhrase);
                setTouched(false);
              }
            }}
          />
          {problem && (
            <p
              id="va-wake-phrase-error"
              role="alert"
              className="max-w-[300px] text-right text-meta leading-snug text-err"
            >
              {problem}
            </p>
          )}
        </div>
      </SettingRow>
      {va.wakeWord && <WakeStatusRow assistantOn={va.enabled} />}
    </SettingGroup>
  );
}

/** What the listener is doing right now, with the model download when it is missing. */
function WakeStatusRow({ assistantOn }: { assistantOn: boolean }) {
  const status = useWake((s) => s.status);
  const dl = useVoiceModelDownload(() => void refreshWakeStatus());
  const line = wakeLine(status, true, assistantOn);
  if (!line) return null;
  const pct = dl.active ? Math.min(100, Math.round((dl.active.done / Math.max(1, dl.active.total)) * 100)) : 0;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 px-4 py-3.5">
      <p
        role="status"
        className={cn(
          "flex min-w-0 flex-1 basis-[220px] items-center gap-2 text-caption leading-relaxed",
          line.kind === "error" ? "text-err" : line.kind === "listening" ? "text-fg" : "text-muted",
        )}
      >
        {line.kind === "listening" && (
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-ok ring-3 ring-ok/25" />
        )}
        {line.kind === "starting" && <Spinner className="h-3.5 w-3.5 shrink-0" />}
        <span className="min-w-0 break-words">{line.text}</span>
      </p>
      {line.kind === "download" && (
        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">
          {dl.active ? (
            <>
              <div
                className="h-1.5 w-28 overflow-hidden rounded-full bg-raised"
                role="progressbar"
                aria-label="Downloading the speech model"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-150"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="tabular w-9 text-right text-meta text-steel">{pct}%</span>
              <Button variant="ghost" size="xs" onClick={dl.cancel} aria-label="Cancel download">
                <X className="h-3 w-3" />
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="outline" size="xs" onClick={() => void dl.start(status?.model ?? WAKE_MODEL)}>
              <Download className="h-3 w-3" />
              Download
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
