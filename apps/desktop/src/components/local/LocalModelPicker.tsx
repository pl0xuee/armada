import { CircleAlert, Download, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/misc";
import { api } from "@/lib/api";
import {
  describeModel,
  formatContext,
  pickLocalModel,
  recallLocalModel,
  rememberLocalModel,
  SMALL_MODEL_NOTE,
} from "@/lib/local";
import type { Account, LocalProbe } from "@/lib/types";
import { PullModelDialog } from "./PullModelDialog";

/**
 * Model choice for a new local-model agent, from the account's live server list.
 * Starts on the model used last with this account.
 */
export function LocalModelPicker({
  account,
  value,
  onChange,
}: {
  account: Account;
  value: string;
  onChange: (model: string) => void;
}) {
  const [probe, setProbe] = useState<LocalProbe | null>(null);
  const [loading, setLoading] = useState(true);
  const [pulling, setPulling] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = await api.probeLocalAccount(account.id);
      setProbe(p);
      onChangeRef.current(pickLocalModel(p.models, recallLocalModel(account.id)));
    } catch (e) {
      setProbe({
        kind: account.local?.kind ?? "custom",
        baseUrl: account.local?.baseUrl ?? "",
        running: false,
        models: [],
        error: e instanceof Error ? e.message : String(e),
        remote: false,
      });
      onChangeRef.current("");
    } finally {
      setLoading(false);
    }
  }, [account.id, account.local?.kind, account.local?.baseUrl]);
  useEffect(() => {
    void load();
  }, [load]);

  const choose = (m: string) => {
    onChange(m);
    rememberLocalModel(account.id, m);
  };
  const selected = probe?.models.find((m) => m.id === value);
  const ollama = account.local?.kind === "ollama";

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor="na-local-model" className="mb-0">
          Model
        </Label>
        {ollama && probe?.running && (
          <Button size="xs" variant="ghost" onClick={() => setPulling(true)}>
            <Download /> Get a model
          </Button>
        )}
      </div>
      {loading ? (
        <p className="flex h-9 items-center gap-2 text-[12.5px] text-muted">
          <Spinner className="h-3.5 w-3.5" /> Asking {account.name} for its models…
        </p>
      ) : !probe?.running ? (
        <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/[0.07] px-3 py-2 text-[12px] text-warn">
          <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{probe?.error ?? "The model server isn't running."}</span>
          <Button size="xs" variant="ghost" onClick={() => void load()}>
            <RefreshCw /> Retry
          </Button>
        </div>
      ) : probe.models.length === 0 ? (
        <p className="text-[12px] text-warn">
          This server has no models yet.{ollama ? " Use “Get a model” to download one." : ""}
        </p>
      ) : (
        <>
          <Select
            id="na-local-model"
            aria-label="Model"
            value={value || undefined}
            onValueChange={choose}
            placeholder="Choose a model"
            options={probe.models.map((m) => ({
              value: m.id,
              label: (
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate font-mono text-[12.5px]">{m.id}</span>
                  <span className="truncate text-[11px] text-steel">{describeModel(m)}</span>
                </span>
              ),
            }))}
          />
          {selected && (
            <p className="text-[11.5px] text-muted tabular">
              {selected.contextLength
                ? `Context length ${formatContext(selected.contextLength)} tokens`
                : "Context length not reported"}
              {selected.tools === false && (
                <span className="text-warn"> · the server says this model has no tool support</span>
              )}
            </p>
          )}
          {probe.remote && (
            <p className="text-[11.5px] text-warn">Runs on another machine: your prompts and code are sent to it.</p>
          )}
        </>
      )}
      <p className="text-[11.5px] leading-snug text-steel">{SMALL_MODEL_NOTE}</p>
      {ollama && (
        // Ollama reports the model's maximum, but runs with its own (small) default window,
        // which the agent's instructions alone can fill.
        <p className="text-[11.5px] leading-snug text-steel">
          Ollama runs models with a small context window by default. Start it with{" "}
          <code className="font-mono text-[11px] text-fg/85">OLLAMA_CONTEXT_LENGTH=32768</code> (or more, if your memory
          allows) so the agent has room to work.
        </p>
      )}
      {ollama && account.local && (
        <PullModelDialog
          open={pulling}
          onOpenChange={setPulling}
          baseUrl={account.local.baseUrl}
          installed={probe?.models.map((m) => m.id) ?? []}
          onPulled={(m) => {
            rememberLocalModel(account.id, m);
            void load();
          }}
        />
      )}
    </div>
  );
}
