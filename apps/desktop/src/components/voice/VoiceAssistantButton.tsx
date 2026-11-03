import { AudioLines } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { isLive } from "@/lib/voiceAssistant";
import { cn, isMac, modKey } from "@/lib/utils";
import { useUi } from "@/store/ui";
import { toggleVoiceAssistant, useVa } from "@/store/voiceAssistant";
import { useWake } from "@/store/wake";
import { useVaReady } from "./ComposerVoiceButtons";

/** What pressing the talk button does right now, and how to say it. */
function useTalk() {
  const phase = useVa((s) => s.phase);
  const ready = useVaReady();
  const live = isLive({ phase });
  const paused = phase === "paused";
  const label = paused ? "Unmute" : live ? "End" : "Talk to Kvistcode";
  const status = paused
    ? "Muted"
    : phase === "speaking"
      ? "Speaking…"
      : phase === "connecting"
        ? "Connecting…"
        : live
          ? "Listening…"
          : null;
  // Not set up yet: take people to the setting instead of failing quietly.
  const press = () => (!ready && !live ? useUi.getState().openSettings("assistant") : toggleVoiceAssistant());
  return { phase, ready, live, paused, label, status, press };
}

/**
 * The title-bar button for the GPT voice assistant. It is a labelled pill, not an icon, because
 * talking to Kvistcode is a main way to use it. `compact` drops the words on narrow windows.
 */
export function VoiceAssistantButton({ compact = false }: { compact?: boolean }) {
  const { live, paused, label, status, press, ready } = useTalk();
  const text = live ? (compact ? null : status) : compact ? "Talk" : label;
  // While the wake phrase is being listened for, say so: the microphone is open.
  const wakePhrase = useWake((s) => (s.status?.state === "listening" && !live ? s.status.phrase : null));
  const tip =
    !ready && !live
      ? "Set up the voice assistant"
      : paused
        ? "Unmute the voice assistant"
        : live
          ? "End the voice assistant"
          : "Talk to Kvistcode: ask for anything out loud";
  return (
    <Tooltip
      content={
        wakePhrase ? (
          <span className="flex flex-col">
            <span>{tip}</span>
            <span className="text-muted">Say “{wakePhrase}” to start</span>
          </span>
        ) : (
          tip
        )
      }
      shortcut={[modKey, "⇧", "A"]}
      side="bottom"
    >
      <button
        type="button"
        onClick={press}
        aria-label={paused ? "Unmute voice assistant" : live ? "End voice assistant" : "Talk to Kvistcode, GPT voice"}
        aria-pressed={live}
        aria-keyshortcuts={isMac ? "Meta+Shift+A" : "Control+Shift+A"}
        className={cn(
          "relative flex h-[26px] shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          live
            ? "border-accent/60 bg-accent/15 text-accent shadow-[0_0_14px_-3px_color-mix(in_srgb,var(--accent)_70%,transparent)]"
            : "border-accent/50 bg-accent text-accent-fg shadow-[0_0_14px_-4px_color-mix(in_srgb,var(--accent)_80%,transparent)] hover:brightness-110",
        )}
      >
        <AudioLines
          className={cn("h-3.5 w-3.5", live && !paused && "animate-pulse motion-reduce:animate-none")}
          aria-hidden
        />
        {text && <span className="whitespace-nowrap">{text}</span>}
        {wakePhrase && (
          <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-ok ring-2 ring-panel" />
        )}
      </button>
    </Tooltip>
  );
}

/** A big "Talk to Kvistcode" call to action for the home screen. */
export function TalkHero() {
  const { live, paused, label, status, press, ready } = useTalk();
  return (
    <button
      type="button"
      onClick={press}
      aria-pressed={live}
      className={cn(
        "group flex min-w-0 flex-1 items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        live
          ? "border-accent/60 bg-accent/10"
          : "border-accent/40 bg-accent/[0.07] hover:border-accent/70 hover:bg-accent/[0.12]",
      )}
    >
      <span
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg shadow-[0_0_18px_-4px_color-mix(in_srgb,var(--accent)_80%,transparent)]",
          live && !paused && "animate-pulse motion-reduce:animate-none",
        )}
      >
        <AudioLines className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] font-semibold">{live ? (status ?? label) : label}</span>
        <span className="block truncate text-[12px] text-muted">
          {live
            ? paused
              ? "Press to unmute"
              : "Press to end"
            : ready
              ? "Start agents, check on them and jump around by voice."
              : "Set up voice with an OpenAI key to talk to your agents."}
        </span>
      </span>
    </button>
  );
}
