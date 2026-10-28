import { CircleAlert, Download, Globe, HardDrive, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { openExternal } from "@/lib/external";
import {
  cleanServerUrl,
  describeModel,
  INSTALL_URL,
  isLoopbackUrl,
  LMSTUDIO_URL,
  LOCAL_KIND_LABEL,
  OLLAMA_URL,
  serverStatusText,
} from "@/lib/local";
import type { LocalKind, LocalProbe, LocalServer } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { onRadioGroupKeyDown } from "../ui/radioKeys";
import { PullModelDialog } from "./PullModelDialog";

const KINDS: LocalKind[] = ["ollama", "lmstudio", "custom"];

const DEFAULT_URL: Record<LocalKind, string> = { ollama: OLLAMA_URL, lmstudio: LMSTUDIO_URL, custom: "" };

/**
 * "Add local model server": detects Ollama and LM Studio on this computer, or takes
 * the address of any OpenAI-compatible server. Reports the chosen server upward.
 */
export function LocalSetup({
  onChange,
}: {
  /** null while the address isn't valid yet. `apiKey` is the optional bearer token. */
  onChange: (server: LocalServer | null, apiKey: string | null) => void;
}) {
  const [kind, setKind] = useState<LocalKind>("ollama");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [detected, setDetected] = useState<Partial<Record<LocalKind, LocalProbe>> | null>(null);
  const [custom, setCustom] = useState<{ probe: LocalProbe | null; checking: boolean; error: string | null }>({
    probe: null,
    checking: false,
    error: null,
  });
  const [pulling, setPulling] = useState(false);

  const detect = useCallback(async () => {
    setDetected(null);
    try {
      const probes = await api.detectLocalServers();
      setDetected(Object.fromEntries(probes.map((p) => [p.kind, p])));
    } catch {
      setDetected({});
    }
  }, []);
  useEffect(() => {
    void detect();
  }, [detect]);

  const customUrl = cleanServerUrl(url);
  const server: LocalServer | null =
    kind === "custom"
      ? customUrl
        ? { kind, baseUrl: customUrl }
        : null
      : { kind, baseUrl: detected?.[kind]?.baseUrl ?? DEFAULT_URL[kind] };

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const serverKey = server ? `${server.kind}|${server.baseUrl}` : "";
  useEffect(() => {
    onChangeRef.current(server, kind === "custom" && token.trim() ? token.trim() : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey, token, kind]);

  const testCustom = async () => {
    if (!customUrl) return;
    setCustom({ probe: null, checking: true, error: null });
    try {
      const probe = await api.probeLocalServer("custom", customUrl, token.trim() || null);
      setCustom({ probe, checking: false, error: null });
    } catch (e) {
      setCustom({ probe: null, checking: false, error: errorMessage(e) });
    }
  };

  const probe = kind === "custom" ? custom.probe : (detected?.[kind] ?? null);
  const checking = kind === "custom" ? custom.checking : detected === null;

  return (
    <div className="space-y-3">
      <div>
        <Label>Model server</Label>
        <div
          className="grid gap-2 sm:grid-cols-3"
          role="radiogroup"
          aria-label="Model server"
          onKeyDown={onRadioGroupKeyDown}
        >
          {KINDS.map((k) => {
            const p = k === "custom" ? null : detected?.[k];
            const active = kind === k;
            return (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={active}
                tabIndex={active ? 0 : -1}
                onClick={() => setKind(k)}
                className={cn(
                  "flex items-start gap-2.5 rounded-xl border p-3 text-left transition-[border-color,background-color,transform] duration-150 active:scale-[0.98] [&_svg]:mt-0.5 [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0",
                  active
                    ? "border-accent/60 bg-accent/[0.07] shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_12%,transparent)] [&_svg]:text-accent"
                    : "border-line bg-base/40 hover:border-line-strong [&_svg]:text-steel",
                )}
              >
                {k === "custom" ? <Globe /> : <HardDrive />}
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-fg">{LOCAL_KIND_LABEL[k]}</span>
                  <span
                    className={cn("flex items-center gap-1.5 text-[11.5px]", p?.running ? "text-ok" : "text-muted")}
                  >
                    {k === "custom" ? (
                      "Any address"
                    ) : detected === null ? (
                      <>
                        <Spinner className="h-3 w-3" /> Looking…
                      </>
                    ) : (
                      serverStatusText(!!p?.running, p?.models.length ?? 0)
                    )}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {kind === "custom" && (
        <div className="space-y-3">
          <div>
            <Label htmlFor="local-url">Server address</Label>
            <div className="flex gap-2">
              <Input
                id="local-url"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setCustom({ probe: null, checking: false, error: null });
                }}
                placeholder="http://127.0.0.1:8080/v1"
                className="font-mono text-[12.5px]"
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                variant="secondary"
                className="h-9"
                disabled={!customUrl || custom.checking}
                onClick={() => void testCustom()}
              >
                {custom.checking ? <Spinner className="h-3.5 w-3.5 text-current" /> : <RefreshCw />}
                Test
              </Button>
            </div>
            <p className="mt-1.5 text-[11.5px] text-steel">
              llama.cpp, vLLM or anything that serves the OpenAI Responses API. Use the address that ends in /v1.
            </p>
          </div>
          <div>
            <Label htmlFor="local-token">
              API key <span className="font-normal text-steel">optional</span>
            </Label>
            <Input
              id="local-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Only if the server requires one"
              autoComplete="off"
              className="font-mono"
            />
          </div>
          {url.trim() !== "" && !customUrl && (
            <p className="flex items-center gap-1.5 text-[12px] text-warn">
              <CircleAlert className="h-3.5 w-3.5 shrink-0" /> The address must start with http:// or https://
            </p>
          )}
          {customUrl && !isLoopbackUrl(customUrl) && (
            <p
              role="note"
              className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/[0.07] px-3 py-2 text-[12px] leading-snug text-warn"
            >
              <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>
                This server is not on this computer. Your prompts and your code will be sent to it over the network, so
                only use a machine you trust.
              </span>
            </p>
          )}
        </div>
      )}

      {/* Status of the selected server */}
      <div
        className="rounded-lg border border-line bg-base/50 px-3 py-2.5 text-[12px] leading-relaxed"
        aria-live="polite"
      >
        {checking ? (
          <span className="flex items-center gap-2 text-muted">
            <Spinner className="h-3.5 w-3.5" /> Checking {LOCAL_KIND_LABEL[kind]}…
          </span>
        ) : probe?.running ? (
          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-ok">
              <span className="h-1.5 w-1.5 rounded-full bg-ok shadow-[0_0_6px_var(--ok)]" />
              {serverStatusText(true, probe.models.length)}
              <span className="font-mono text-[11px] text-steel">{probe.baseUrl}</span>
            </p>
            {probe.models.slice(0, 4).map((m) => (
              <p key={m.id} className="truncate text-muted">
                <span className="font-mono text-fg/90">{m.id}</span>
                {describeModel(m) && <span className="text-steel"> · {describeModel(m)}</span>}
              </p>
            ))}
            {probe.models.length > 4 && <p className="text-steel">and {probe.models.length - 4} more</p>}
            {probe.models.length === 0 && (
              <p className="text-warn">
                No models yet.{kind === "ollama" ? " Get one below." : " Download one in the app."}
              </p>
            )}
            {kind === "ollama" && (
              <Button size="sm" variant="secondary" onClick={() => setPulling(true)}>
                <Download /> Get a model
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-1.5">
            <p className="flex items-start gap-1.5 text-warn/90">
              <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
              {custom.error && kind === "custom"
                ? custom.error
                : (probe?.error ??
                  (kind === "custom"
                    ? "Enter the address, then Test it. You can also add it now and start the server later."
                    : "Not running"))}
            </p>
            <div className="flex flex-wrap gap-2">
              {INSTALL_URL[kind] && (
                <Button size="sm" variant="secondary" onClick={() => void openExternal(INSTALL_URL[kind] as string)}>
                  <Download /> {kind === "ollama" ? "Install Ollama" : "Get LM Studio"}
                </Button>
              )}
              {kind !== "custom" && (
                <Button size="sm" variant="ghost" onClick={() => void detect()}>
                  <RefreshCw /> Check again
                </Button>
              )}
            </div>
            {kind !== "custom" && (
              <p className="text-steel">
                You can add it now and start it later. Armada checks again whenever you launch an agent.
              </p>
            )}
          </div>
        )}
      </div>

      {kind === "ollama" && server && (
        <PullModelDialog
          open={pulling}
          onOpenChange={setPulling}
          baseUrl={server.baseUrl}
          installed={probe?.models.map((m) => m.id) ?? []}
          onPulled={() => void detect()}
        />
      )}
    </div>
  );
}
