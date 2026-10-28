import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, onVoiceDownload } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

/** Download state for one speech model at a time, fed by the voice-download events. */
export function useVoiceModelDownload(onFinished?: (id: string) => void) {
  const [active, setActive] = useState<{ id: string; done: number; total: number } | null>(null);

  // Only react to progress for the model this component started (others may download elsewhere).
  const startedRef = useRef<string | null>(null);

  useEffect(() => {
    let off: (() => void) | undefined;
    let dead = false;
    void onVoiceDownload((e) => {
      if (e.state === "progress" && e.id === startedRef.current) setActive({ id: e.id, done: e.done, total: e.total });
    }).then((u) => (dead ? u() : (off = u)));
    return () => {
      dead = true;
      off?.();
    };
  }, []);

  const start = async (id: string) => {
    startedRef.current = id;
    setActive({ id, done: 0, total: 1 });
    try {
      await api.voiceDownloadModel(id);
      onFinished?.(id);
    } catch (e) {
      const msg = errorMessage(e);
      if (!/cancel/i.test(msg)) toast.error("Couldn't download the speech model", { description: msg });
    } finally {
      startedRef.current = null;
      setActive(null);
    }
  };

  const cancel = () => void api.voiceCancelDownload();
  return { active, start, cancel };
}
