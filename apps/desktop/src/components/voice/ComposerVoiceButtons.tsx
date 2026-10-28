import { AudioLines } from "lucide-react";
import { useState } from "react";
import { DictateButton } from "@/components/DictateButton";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import { isLive } from "@/lib/voiceAssistant";
import { cn, isMac, modKey } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { toggleVoiceAssistant, useVa } from "@/store/voiceAssistant";

/** True when a voice-assistant session can start: enabled and paid for by an OpenAI API-key account. */
export function useVaReady(): boolean {
  const va = useApp((s) => s.settings?.voiceAssistant);
  const accounts = useApp((s) => s.accounts);
  return (
    !!va?.enabled &&
    !!va.accountId &&
    accounts.some((a) => a.id === va.accountId && a.provider === "codex" && a.authKind === "api_key")
  );
}

/**
 * The two round voice buttons that sit left of a composer's send button: on-device dictation and
 * the GPT voice assistant. Never wraps or shrinks.
 */
export function ComposerVoiceButtons({
  onText,
  className,
}: {
  onText: (text: string, autoSend: boolean) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex shrink-0 items-center gap-1.5", className)}>
      <DictateButton onText={onText} round />
      <VoiceAssistantComposerButton />
    </div>
  );
}

function VoiceAssistantComposerButton() {
  const live = useVa((s) => isLive({ phase: s.phase }));
  const ready = useVaReady();
  const [help, setHelp] = useState(false);

  const cls = cn(
    "relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
    live
      ? "border-accent/60 bg-accent/15 text-accent shadow-[0_0_12px_-2px_color-mix(in_srgb,var(--accent)_70%,transparent)]"
      : "border-line-strong bg-raised/60 text-muted hover:bg-raised hover:text-fg",
  );
  const icon = <AudioLines className={cn("h-4 w-4", live && "animate-pulse motion-reduce:animate-none")} aria-hidden />;
  const shortcut = [modKey, "⇧", "A"];
  const label = live ? "End voice assistant" : "Talk to Armada · GPT voice";

  if (!ready && !live) {
    return (
      <Popover open={help} onOpenChange={setHelp}>
        <Tooltip content={label} shortcut={shortcut}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cls}
              aria-label={`Talk to Armada, GPT voice (${modKey}+Shift+A). Needs setup`}
              aria-haspopup="dialog"
              aria-expanded={help}
              aria-keyshortcuts={isMac ? "Meta+Shift+A" : "Control+Shift+A"}
            >
              {icon}
            </button>
          </PopoverTrigger>
        </Tooltip>
        <PopoverContent side="top" align="end" className="w-64">
          <div className="text-[13px] font-medium text-fg">Voice assistant needs setup</div>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">
            Talking to Armada uses OpenAI's realtime voice. Turn it on and pick an OpenAI API-key account to pay for
            sessions.
          </p>
          <Button
            size="sm"
            variant="primary"
            className="mt-2.5 w-full"
            onClick={() => {
              setHelp(false);
              useUi.getState().openSettings("assistant");
            }}
          >
            Open Voice assistant settings
          </Button>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Tooltip content={label} shortcut={shortcut}>
      <button
        type="button"
        onClick={toggleVoiceAssistant}
        className={cls}
        aria-label={live ? "End voice assistant" : `Talk to Armada, GPT voice (${modKey}+Shift+A)`}
        aria-pressed={live}
        aria-keyshortcuts={isMac ? "Meta+Shift+A" : "Control+Shift+A"}
      >
        {icon}
      </button>
    </Tooltip>
  );
}
