import { FolderOpen, Music, RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { Tooltip } from "@/components/ui/tooltip";
import { isTauri } from "@/lib/api";
import { basename, errorMessage } from "@/lib/utils";

const AUDIO_EXTENSIONS = ["wav", "ogg", "mp3", "flac"];

/** Native audio file picker; prompts for a path in the browser mock. */
async function pickAudioFile(): Promise<string | null> {
  if (!isTauri()) {
    const v = window.prompt("Sound file (browser mock)", "/home/sam/Music/chime.wav");
    return v?.trim() || null;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ multiple: false, filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }] });
  return typeof res === "string" ? res : null;
}

/** Shows which sound an event uses and lets the user swap in their own file. */
export function CustomSoundLine({
  path,
  disabled,
  eventLabel,
  onChange,
}: {
  path: string | null;
  disabled?: boolean;
  eventLabel: string;
  onChange: (path: string | null) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const run = async (next: () => Promise<string | null | undefined>) => {
    setBusy(true);
    try {
      const value = await next();
      if (value !== undefined) await onChange(value);
    } catch (e) {
      toast.error("Couldn't change the sound", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const choose = () =>
    run(async () => {
      const p = await pickAudioFile();
      if (!p) return undefined;
      const ext = p.split(".").pop()?.toLowerCase() ?? "";
      if (!AUDIO_EXTENSIONS.includes(ext)) throw new Error("Choose a .wav, .ogg, .mp3 or .flac file.");
      return p;
    });

  return (
    <span className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="flex min-w-0 items-center gap-1.5 rounded-md border border-line bg-base/50 px-2 py-0.5 text-[11.5px]">
        <Music className="h-3 w-3 shrink-0 text-steel" />
        {path ? (
          <Tooltip content={path}>
            <span className="selectable min-w-0 max-w-[220px] truncate font-mono text-[11px] text-fg/90">
              {basename(path)}
            </span>
          </Tooltip>
        ) : (
          <span className="text-muted">Armada sound</span>
        )}
      </span>
      <Button
        size="xs"
        variant="ghost"
        disabled={disabled || busy}
        onClick={() => void choose()}
        aria-label={`Choose a sound file for ${eventLabel}`}
      >
        {busy ? <Spinner className="h-3 w-3" /> : <FolderOpen className="!h-3 !w-3" />}
        Choose file…
      </Button>
      {path && (
        <Button
          size="xs"
          variant="ghost"
          disabled={disabled || busy}
          onClick={() => void run(async () => null)}
          aria-label={`Reset ${eventLabel} to Armada sound`}
        >
          <RotateCcw className="!h-3 !w-3" />
          Reset to Armada sound
        </Button>
      )}
    </span>
  );
}
