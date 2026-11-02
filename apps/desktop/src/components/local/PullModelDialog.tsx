import { Download, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { openExternal } from "@/lib/external";
import { isLoopbackUrl, pullPercent, pullText } from "@/lib/local";
import { describeHardware, diskAllows, QUALITY_NOTE, rankedCatalog } from "@/lib/localFit";
import type { Hardware, PullProgress } from "@/lib/types";
import { cn, errorMessage, uuid } from "@/lib/utils";

/**
 * Downloads a model into Ollama: a short list of coding models that support tool
 * calling, ranked by what this computer can run (memory, free disk), or any name
 * from the Ollama library. One download at a time; closing the dialog cancels it
 * (Ollama keeps the partial download for next time).
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
  const [hw, setHw] = useState<Hardware | null>(null);
  const [hwDone, setHwDone] = useState(false);

  // This computer's memory and free disk decide which downloads make sense.
  // They only describe an Ollama running here.
  const here = isLoopbackUrl(baseUrl);
  useEffect(() => {
    if (!open || !here) return;
    let alive = true;
    setHwDone(false);
    api
      .localHardware()
      .then((h) => alive && setHw(h))
      .catch(() => alive && setHw(null))
      .finally(() => alive && setHwDone(true));
    return () => {
      alive = false;
    };
  }, [open, here]);
  const ranked = rankedCatalog(here ? hw : null);

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
        description="Models download into Ollama. These all support tool calling, which Kvistcode's agents need."
        className="w-[min(560px,calc(100vw-32px))]"
      >
        <DialogBody className="space-y-2">
          <p className="text-[12px] leading-snug text-muted" aria-live="polite">
            {!here ? (
              "This Ollama runs on another machine, so its memory and disk can't be checked from here."
            ) : hw ? (
              <>
                This computer: <span className="text-fg/90">{describeHardware(hw)}</span>
                {hw.diskFreeBytes != null && <> · {Math.round(hw.diskFreeBytes / 1e9)} GB free for models</>}
              </>
            ) : hwDone ? (
              "Couldn't read this computer's memory, so how well each model fits is unknown."
            ) : (
              <span className="flex items-center gap-1.5">
                <Spinner className="h-3 w-3" /> Checking this computer…
              </span>
            )}
          </p>
          {ranked.map(({ model: m, fit, best }) => {
            const isActive = active?.model === m.name;
            const done = have.has(m.name);
            const pct = isActive && active.progress ? pullPercent(active.progress) : null;
            const roomOnDisk = !here || diskAllows(hw, m.sizeGb);
            return (
              <div
                key={m.name}
                className={cn(
                  "rounded-xl border px-3 py-2.5",
                  best ? "border-accent/50 bg-accent/[0.05]" : "border-line bg-base/40",
                  fit.level === "no" && "opacity-70",
                )}
              >
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-[13px] font-medium text-fg">{m.title}</span>
                      <span className="font-mono text-[11px] text-steel">{m.name}</span>
                      {best && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-accent">
                          <Sparkles className="h-3 w-3" /> Best for this computer
                        </span>
                      )}
                    </div>
                    <p className="text-[11.5px] text-muted">
                      {m.blurb} · {m.sizeGb} GB download
                    </p>
                    {here && fit.level !== "unknown" && (
                      <p
                        className={cn(
                          "text-[11.5px]",
                          fit.level === "great" || fit.level === "ok"
                            ? "text-ok"
                            : fit.level === "no"
                              ? "text-err"
                              : "text-warn",
                        )}
                      >
                        {fit.note}
                      </p>
                    )}
                    {!roomOnDisk && (
                      <p className="text-[11.5px] text-err">
                        Not enough free disk space ({Math.round((hw?.diskFreeBytes ?? 0) / 1e9)} GB free).
                      </p>
                    )}
                  </div>
                  {isActive ? (
                    <Button size="sm" variant="ghost" onClick={cancel} aria-label={`Cancel download of ${m.name}`}>
                      <X /> Cancel
                    </Button>
                  ) : done ? (
                    <span className="text-[12px] text-ok">Downloaded</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!!active || !roomOnDisk}
                      onClick={() => void start(m.name)}
                    >
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
          <p className="text-[11.5px] leading-snug text-steel">{QUALITY_NOTE}</p>

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
