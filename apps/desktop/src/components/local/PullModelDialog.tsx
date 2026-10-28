import { Download, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { openExternal } from "@/lib/external";
import { pullPercent, pullText, RECOMMENDED_MODELS } from "@/lib/local";
import type { PullProgress } from "@/lib/types";
import { errorMessage, uuid } from "@/lib/utils";

/**
 * Downloads a model into Ollama: a short list of recommended coding models that
 * support tool calling, or any name from the Ollama library. One download at a time;
 * closing the dialog cancels it (Ollama keeps the partial download for next time).
 */
export function PullModelDialog({
  open,
  onOpenChange,
  baseUrl,
  installed,
  onPulled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  baseUrl: string;
  installed: string[];
  onPulled: (model: string) => void;
}) {
  const [active, setActive] = useState<{ model: string; progress: PullProgress | null } | null>(null);
  const [custom, setCustom] = useState("");
  const pullId = useRef<string | null>(null);

  const cancel = () => {
    if (pullId.current) void api.cancelLocalPull(pullId.current);
  };

  // Leaving (or unmounting) mid-download stops it.
  useEffect(() => {
    if (!open) cancel();
    return cancel;
  }, [open]);

  const start = async (model: string) => {
    if (active) return;
    const id = uuid();
    pullId.current = id;
    setActive({ model, progress: null });
    try {
      await api.pullLocalModel(baseUrl, model, id, (progress) => setActive({ model, progress }));
      toast.success(`Downloaded ${model}`);
      onPulled(model);
    } catch (e) {
      const msg = errorMessage(e);
      if (!/cancel/i.test(msg)) toast.error(`Couldn't download ${model}`, { description: msg });
    } finally {
      pullId.current = null;
      setActive(null);
    }
  };

  const have = new Set(installed);
  const customName = custom.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Get a model"
        description="Models download into Ollama and run on this computer. These all support tool calling, which Armada's agents need."
        className="w-[min(540px,calc(100vw-32px))]"
      >
        <DialogBody className="space-y-2">
          {RECOMMENDED_MODELS.map((m) => {
            const isActive = active?.model === m.name;
            const done = have.has(m.name);
            const pct = isActive && active.progress ? pullPercent(active.progress) : null;
            return (
              <div key={m.name} className="rounded-xl border border-line bg-base/40 px-3 py-2.5">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[13px] font-medium text-fg">{m.title}</span>
                      <span className="font-mono text-[11px] text-steel">{m.name}</span>
                    </div>
                    <p className="text-[11.5px] text-muted">
                      {m.blurb} · approx. {m.sizeGb} GB download · approx. {m.ramGb} GB RAM
                    </p>
                  </div>
                  {isActive ? (
                    <Button size="sm" variant="ghost" onClick={cancel} aria-label={`Cancel download of ${m.name}`}>
                      <X /> Cancel
                    </Button>
                  ) : done ? (
                    <span className="text-[12px] text-ok">Downloaded</span>
                  ) : (
                    <Button size="sm" variant="secondary" disabled={!!active} onClick={() => void start(m.name)}>
                      <Download /> Get
                    </Button>
                  )}
                </div>
                {isActive && (
                  <div className="mt-2" role="status" aria-live="polite">
                    <div className="h-1.5 overflow-hidden rounded-full bg-raised">
                      <div
                        className="h-full rounded-full bg-accent transition-[width] duration-300"
                        style={{ width: `${pct ?? 6}%` }}
                      />
                    </div>
                    <p className="mt-1 flex items-center gap-1.5 text-[11.5px] text-muted tabular">
                      {pct == null && <Spinner className="h-3 w-3" />}
                      {active.progress ? pullText(active.progress) : "Starting…"}
                    </p>
                  </div>
                )}
              </div>
            );
          })}

          <div className="pt-2">
            <Label htmlFor="pull-custom">Or any model from the Ollama library</Label>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (customName) void start(customName);
              }}
            >
              <Input
                id="pull-custom"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="e.g. qwen2.5-coder:7b"
                className="font-mono text-[12.5px]"
                disabled={!!active}
                autoComplete="off"
                spellCheck={false}
              />
              <Button type="submit" variant="secondary" className="h-9" disabled={!customName || !!active}>
                <Download /> Get
              </Button>
            </form>
            <p className="mt-1.5 text-[11.5px] text-steel">
              Browse{" "}
              <button
                type="button"
                onClick={() => void openExternal("https://ollama.com/library")}
                className="text-accent underline-offset-2 hover:underline"
              >
                ollama.com/library
              </button>
              . Pick models tagged “tools”.
            </p>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {active ? "Cancel & close" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
