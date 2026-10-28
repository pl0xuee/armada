import { AudioLines } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { isLive } from "@/lib/voiceAssistant";
import { cn, modKey } from "@/lib/utils";
import { toggleVoiceAssistant, useVa } from "@/store/voiceAssistant";

/** Title-bar button that starts or ends the voice assistant. */
export function VoiceAssistantButton() {
  const phase = useVa((s) => s.phase);
  const live = isLive({ phase });
  return (
    <Tooltip content={live ? "End voice assistant" : "Voice assistant"} shortcut={[modKey, "⇧", "A"]} side="bottom">
      <button
        type="button"
        onClick={toggleVoiceAssistant}
        aria-label={live ? "End voice assistant" : "Start voice assistant"}
        aria-pressed={live}
        className={cn(
          "relative flex h-6 w-6 items-center justify-center rounded-md transition-colors",
          live ? "bg-accent/15 text-accent" : "text-steel hover:bg-raised hover:text-fg",
        )}
      >
        <AudioLines className="h-3.5 w-3.5" />
        {live && (
          <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
        )}
      </button>
    </Tooltip>
  );
}
