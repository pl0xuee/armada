import { CircleAlert, ChevronRight, Gauge, Info, MemoryStick, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import { describeModel, formatBytes, formatContext } from "@/lib/local";
import { CONTEXT_CHOICES, describeHardware } from "@/lib/localFit";
import type { Account, Hardware, HealthIssue, LocalHealth, LocalPrefs, SpeedResult } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";

const ICON = { error: CircleAlert, warn: TriangleAlert, info: Info } as const;
const TONE = {
  error: "border-err/30 bg-err/[0.06] text-err",
  warn: "border-warn/30 bg-warn/[0.07] text-warn",
  info: "border-line bg-base/40 text-muted",
} as const;

function Issue({ issue }: { issue: HealthIssue }) {
  const Icon = ICON[issue.severity];
  return (
    <li
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] leading-snug",
        TONE[issue.severity],
      )}
    >
      <Icon className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">
        <span className="block">{issue.message}</span>
        {issue.fix && <span className="mt-0.5 block text-fg/80">{issue.fix}</span>}
      </span>
    </li>
  );
}

/**
 * Local model server details for an account: version, what is loaded in memory,
 * problems with a fix each, per-model speed test / unload / delete, and the
 * context window agents get. Loads only when opened.
 */
export function LocalHealthPanel({ account }: { account: Account }) {
  const [open, setOpen] = useState(false);
  const [health, setHealth] = useState<LocalHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hw, setHw] = useState<Hardware | null>(null);
  const [prefs, setPrefs] = useState<LocalPrefs>({ contextTokens: null });
  const [busy, setBusy] = useState<string | null>(null);
  const [speed, setSpeed] = useState<Record<string, SpeedResult>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHealth(await api.localHealth(account.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [account.id]);

  useEffect(() => {
    if (!open) return;
    void load();
    api.localHardware().then(setHw, () => setHw(null));
    api.getLocalPrefs().then(setPrefs, () => undefined);
  }, [open, load]);

  const run = async (key: string, fn: () => Promise<void>, failure: string) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.error(failure, { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const ollama = account.local?.kind === "ollama";
  const loadedIds = new Set(health?.loaded.map((m) => m.id));
  const remote = health?.remote ?? false;
  const choice = prefs.contextTokens == null ? "auto" : String(prefs.contextTokens);

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[12px] font-medium text-muted transition-colors hover:text-fg"
      >
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
        Server details
        {health && !open ? null : health && health.issues.some((i) => i.severity !== "info") ? (
          <span className="ml-1 h-1.5 w-1.5 rounded-full bg-warn" aria-label="has problems" />
        ) : null}
      </button>
      {open && (
        <div className="mt-2 space-y-3 rounded-xl border border-line bg-base/40 p-3" aria-live="polite">
          {loading && !health ? (
            <p className="flex items-center gap-2 text-[12px] text-muted">
              <Spinner className="h-3.5 w-3.5" /> Checking the server…
            </p>
          ) : error ? (
            <p className="text-[12px] text-err">{error}</p>
          ) : health ? (
            <>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    health.running ? "bg-ok shadow-[0_0_6px_var(--ok)]" : "bg-err",
                  )}
                />
                <span className="font-medium text-fg">
                  {health.flavor}
                  {health.version ? ` ${health.version}` : ""}
                </span>
                <span className="font-mono text-[11px] text-steel">{health.baseUrl}</span>
                <Button size="xs" variant="ghost" className="ml-auto" onClick={() => void load()} disabled={loading}>
                  <RefreshCw className={cn(loading && "animate-spin")} /> Refresh
                </Button>
              </div>

              {health.issues.length > 0 ? (
                <ul className="space-y-1.5">
                  {health.issues.map((i) => (
                    <Issue key={i.code} issue={i} />
                  ))}
                </ul>
              ) : (
                <p className="text-[12px] text-ok">No problems found.</p>
              )}

              {health.loaded.length > 0 && (
                <div>
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-steel">In memory now</p>
                  <ul className="space-y-1">
                    {health.loaded.map((m) => (
                      <li key={m.id} className="flex items-center gap-2 text-[12px]">
                        <MemoryStick className="h-3.5 w-3.5 shrink-0 text-steel" />
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-mono text-fg/90">{m.id}</span>
                          <span className="text-steel">
                            {m.contextLength ? ` · ${formatContext(m.contextLength)} window` : ""}
                            {m.sizeBytes && m.vramBytes != null
                              ? ` · ${Math.round((m.vramBytes / m.sizeBytes) * 100)}% on GPU`
                              : ""}
                          </span>
                        </span>
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={busy !== null}
                          onClick={() =>
                            void run(
                              `unload:${m.id}`,
                              async () => {
                                await api.localUnloadModel(account.id, m.id);
                                await load();
                              },
                              `Couldn't unload ${m.id}`,
                            )
                          }
                        >
                          {busy === `unload:${m.id}` ? <Spinner className="h-3 w-3" /> : null} Unload
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {health.models.length > 0 && (
                <div>
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-steel">Models</p>
                  <ul className="divide-y divide-line/60">
                    {health.models.map((m) => {
                      const r = speed[m.id];
                      return (
                        <li key={m.id} className="py-1.5 text-[12px]">
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate">
                              <span className="font-mono text-fg/90">{m.id}</span>
                              <span className="text-steel"> · {describeModel(m) || "size unknown"}</span>
                              {m.tools === false && <span className="text-warn"> · no tools</span>}
                              {loadedIds.has(m.id) && <span className="text-ok"> · loaded</span>}
                            </span>
                            <Button
                              size="xs"
                              variant="ghost"
                              disabled={busy !== null || m.tools === false}
                              onClick={() =>
                                void run(
                                  `speed:${m.id}`,
                                  async () => {
                                    const res = await api.localSpeedTest(account.id, m.id);
                                    setSpeed((s) => ({ ...s, [m.id]: res }));
                                  },
                                  `Speed test failed for ${m.id}`,
                                )
                              }
                            >
                              {busy === `speed:${m.id}` ? <Spinner className="h-3 w-3" /> : <Gauge />} Test speed
                            </Button>
                            {ollama && !remote && (
                              <Button
                                size="xs"
                                variant="ghost"
                                aria-label={`Delete ${m.id}`}
                                disabled={busy !== null}
                                onClick={() => setConfirmDelete(confirmDelete === m.id ? null : m.id)}
                              >
                                <Trash2 />
                              </Button>
                            )}
                          </div>
                          {r && (
                            <p className="mt-0.5 text-[11.5px] text-muted tabular">
                              {r.tokensPerSecond != null ? (
                                <>
                                  <span className="font-medium text-fg">{r.tokensPerSecond.toFixed(1)} tokens/s</span>
                                  {r.tokensPerSecond < 10 && (
                                    <span className="text-warn"> · slow for an agent; try a smaller model</span>
                                  )}
                                </>
                              ) : (
                                "The server didn't report a speed"
                              )}
                              {r.loadMs != null && r.loadMs > 1000 && (
                                <span className="text-steel">
                                  {" "}
                                  · took {(r.loadMs / 1000).toFixed(1)}s to load first
                                </span>
                              )}
                            </p>
                          )}
                          {confirmDelete === m.id && (
                            <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-err/30 bg-err/[0.06] px-2.5 py-1.5 text-[12px] text-err">
                              <span className="flex-1">
                                Delete {m.id} from disk{m.sizeBytes ? ` (frees ${formatBytes(m.sizeBytes)})` : ""}?
                              </span>
                              <Button size="xs" variant="ghost" onClick={() => setConfirmDelete(null)}>
                                Keep
                              </Button>
                              <Button
                                size="xs"
                                variant="danger-solid"
                                disabled={busy !== null}
                                onClick={() =>
                                  void run(
                                    `delete:${m.id}`,
                                    async () => {
                                      await api.localDeleteModel(account.id, m.id);
                                      setConfirmDelete(null);
                                      await load();
                                    },
                                    `Couldn't delete ${m.id}`,
                                  )
                                }
                              >
                                {busy === `delete:${m.id}` ? <Spinner className="h-3 w-3" /> : null} Delete
                              </Button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {ollama && !remote && (
                <div>
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-steel">
                    Context window for agents
                  </p>
                  <div className="max-w-[260px]">
                    <Select
                      aria-label="Context window for agents"
                      value={choice}
                      onValueChange={(v) => {
                        const next: LocalPrefs = { contextTokens: v === "auto" ? null : Number(v) };
                        setPrefs(next);
                        api
                          .setLocalPrefs(next)
                          .catch((e) => toast.error("Couldn't save", { description: errorMessage(e) }));
                      }}
                      options={CONTEXT_CHOICES.map((c) => ({
                        value: c.value == null ? "auto" : String(c.value),
                        label: c.label,
                      }))}
                    />
                  </div>
                  <p className="mt-1 text-[11.5px] leading-snug text-steel">
                    How much an agent can keep in mind. Automatic picks up to 64k from your memory
                    {hw ? ` (${describeHardware(hw)})` : ""}. Bigger windows use more memory; below 32k agents forget
                    files and instructions.
                  </p>
                </div>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
