import { Link2, Radio, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { relativeTimeLong } from "@/lib/format";
import type { Agent, RemoteStatus, ShareLink } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { useApp } from "@/store/app";
import { pollRemoteStatus } from "./settings/remoteStatus";
import { useUi } from "@/store/ui";
import { CopyButton } from "./CopyButton";
import { Button } from "./ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "./ui/dialog";
import { Skeleton } from "./ui/skeleton";
import { Spinner } from "./ui/misc";

/** "Share live view…": read-only link to one agent, served by the remote-control server. */
export function ShareDialog() {
  const agent = useUi((s) => s.shareAgent);
  const close = () => useUi.getState().setShareAgent(null);
  return (
    <Dialog open={!!agent} onOpenChange={(o) => !o && close()}>
      <DialogContent
        title="Share live view"
        description={agent ? `A read-only link that follows “${agent.title}” as it works.` : undefined}
      >
        {agent && <ShareBody agent={agent} onClose={close} />}
      </DialogContent>
    </Dialog>
  );
}

function ShareBody({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const settings = useApp((s) => s.settings);
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "enable" | "create" | string>(null);
  /** Consent step: where the shared view may be opened from (defaults to this computer only). */
  const [scope, setScope] = useState<"local" | "lan">("local");
  /** How long a new link works (hours). */
  const [hours, setHours] = useState(24);
  /** Links created in this dialog: only their creation response carries the URL. */
  const [urls, setUrls] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.remoteStatus());
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const links = status?.shares.filter((s) => s.agentId === agent.id) ?? [];

  const [createError, setCreateError] = useState<string | null>(null);

  const create = useCallback(async () => {
    setBusy("create");
    setCreateError(null);
    try {
      const link = await api.createShareLink(agent.id, hours);
      if (link.url) setUrls((u) => ({ ...u, [link.id]: link.url as string }));
      await refresh();
    } catch (e) {
      setCreateError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [agent.id, hours, refresh]);

  const enable = async () => {
    if (!settings) return;
    setBusy("enable");
    try {
      await useApp
        .getState()
        .setSettings({ ...settings, remote: { ...settings.remote, enabled: true, lan: scope === "lan" } });
      // The server starts asynchronously: wait for it so we don't flash an error or a stale "off".
      await pollRemoteStatus((st) => setStatus(st));
      setLoadError(null);
    } catch (e) {
      toast.error("Couldn't turn on remote access", { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (link: ShareLink) => {
    setBusy(link.id);
    try {
      await api.revokeShareLink(link.id);
      await refresh();
      toast("Share link revoked", { description: "Anyone using it loses access immediately." });
    } catch (e) {
      toast.error("Couldn't revoke the link", { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <DialogBody className="space-y-4">
        {loadError ? (
          <div className="rounded-xl border border-err/30 bg-err/[0.06] p-3 text-[12.5px] text-err">
            Couldn't read remote status: <span className="font-mono">{loadError}</span>
          </div>
        ) : !status ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
        ) : !status.enabled ? (
          <fieldset className="rounded-xl border border-line-strong bg-card/70 p-4">
            <legend className="sr-only">Turn on remote access</legend>
            <div className="flex items-start gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-accent/30 bg-accent/10 text-accent">
                <Radio className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium">Remote access is off</p>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">
                  Share links are served by Armada's built-in remote server. Choose who can reach it:
                </p>
                <div role="radiogroup" aria-label="Who can open the link" className="mt-3 space-y-2">
                  <ScopeOption
                    checked={scope === "local"}
                    onSelect={() => setScope("local")}
                    title="This computer only"
                    hint="Open the link in a browser on this machine. Nothing is exposed to the network."
                  />
                  <ScopeOption
                    checked={scope === "lan"}
                    onSelect={() => setScope("lan")}
                    title="Allow devices on my network"
                    hint="Phones and computers on this network can open share links, and anyone who scans a pairing code while it's shown gets full control. Traffic on the local network isn't encrypted: only on networks you trust, or over a VPN such as Tailscale."
                    warn
                  />
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  className="mt-3"
                  disabled={busy !== null}
                  onClick={() => void enable()}
                >
                  {busy === "enable" ? <Spinner className="h-3.5 w-3.5 text-current" /> : <Radio />}
                  {scope === "lan" ? "Turn on for my network" : "Turn on for this computer"}
                </Button>
              </div>
            </div>
          </fieldset>
        ) : !status.running ? (
          <div className="flex items-start gap-2.5 rounded-xl border border-err/30 bg-err/[0.06] p-3.5 text-[12.5px]">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-err" />
            <div>
              <p className="font-medium text-err">The remote server isn't running</p>
              <p className="mt-0.5 text-muted">{status.error ?? "It failed to start."}</p>
              <Button
                size="xs"
                variant="ghost"
                className="-ml-2 mt-1.5"
                onClick={() => {
                  onClose();
                  useUi.getState().openSettings("remote");
                }}
              >
                Open Remote & mobile settings
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {links.length === 0 &&
              (busy === "create" ? (
                <div className="flex items-center gap-2 text-[12.5px] text-muted" role="status">
                  <Spinner className="h-3.5 w-3.5" /> Creating link…
                </div>
              ) : createError ? (
                <div
                  className="flex items-start gap-2.5 rounded-xl border border-err/30 bg-err/[0.06] p-3 text-[12.5px]"
                  role="alert"
                >
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-err" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-err">Couldn't create a share link</p>
                    <p className="mt-0.5 break-words text-muted">{createError}</p>
                  </div>
                  <Button size="xs" variant="secondary" className="shrink-0" onClick={() => void create()}>
                    Retry
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-line-strong px-3.5 py-3">
                  <span className="text-[12.5px] text-muted">No active link for this agent.</span>
                  <div className="flex items-center gap-2">
                    <ExpiryPicker hours={hours} onChange={setHours} disabled={busy !== null} />
                    <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void create()}>
                      <Link2 /> Create link
                    </Button>
                  </div>
                </div>
              ))}
            {links.map((l) => {
              const url = urls[l.id] ?? l.url;
              return (
                <div key={l.id} className="rounded-xl border border-line-strong bg-card/70 p-3">
                  <div className="flex items-center gap-2">
                    <Link2 className="h-4 w-4 shrink-0 text-accent" />
                    <span className="selectable min-w-0 flex-1 truncate font-mono text-[12px] text-fg">
                      {url ?? "The link was shown when it was created. Revoke it and create a new one to copy it."}
                    </span>
                    {url && <CopyButton text={url} label="Copy link" />}
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[11.5px] text-steel">
                    <span>
                      Created {relativeTimeLong(l.createdAt)} · expires {new Date(l.expiresAt).toLocaleString()}
                    </span>
                    <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void revoke(l)}>
                      {busy === l.id ? <Spinner className="h-3 w-3" /> : <Trash2 className="!h-3 !w-3" />}
                      Revoke
                    </Button>
                  </div>
                </div>
              );
            })}
            {links.length > 0 && createError && (
              <p className="text-[12px] text-err" role="alert">
                Couldn't create another link: {createError}
              </p>
            )}
            {links.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void create()}>
                  {busy === "create" ? <Spinner className="h-3.5 w-3.5" /> : <Link2 />}
                  Create another link
                </Button>
                <ExpiryPicker hours={hours} onChange={setHours} disabled={busy !== null} />
              </div>
            )}
          </div>
        )}
        <p className="flex items-start gap-2 text-[11.5px] leading-relaxed text-steel">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Viewers see this agent's messages (secrets hidden) and a short outline of the tools it ran. They can't see
          command output, file contents, diffs, approval requests or local paths, and can't change anything. The link
          stops working when it expires or the agent is archived or deleted. With LAN access on, traffic isn't
          encrypted: use it on networks you trust, or over a VPN such as Tailscale.
        </p>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}

function ExpiryPicker({
  hours,
  onChange,
  disabled,
}: {
  hours: number;
  onChange: (hours: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[11.5px] text-steel">
      Expires after
      <select
        value={hours}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-7 rounded-md border border-line-strong bg-card px-1.5 text-[12px] text-fg outline-none focus:border-accent/60"
      >
        <option value={1}>1 hour</option>
        <option value={24}>24 hours</option>
        <option value={168}>7 days</option>
      </select>
    </label>
  );
}

function ScopeOption({
  checked,
  onSelect,
  title,
  hint,
  warn,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  hint: string;
  warn?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors",
        checked
          ? warn
            ? "border-warn/45 bg-warn/[0.06]"
            : "border-accent/45 bg-accent/[0.06]"
          : "border-line hover:border-line-strong",
      )}
    >
      <input type="radio" name="share-scope" checked={checked} onChange={onSelect} className="peer sr-only" />
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border peer-focus-visible:ring-2 peer-focus-visible:ring-accent/60",
          checked ? (warn ? "border-warn" : "border-accent") : "border-line-strong",
        )}
      >
        {checked && <span className={cn("h-2 w-2 rounded-full", warn ? "bg-warn" : "bg-accent")} />}
      </span>
      <span className="min-w-0">
        <span className="block text-[12.5px] font-medium text-fg">{title}</span>
        <span className="block text-[11.5px] leading-snug text-muted">{hint}</span>
      </span>
    </label>
  );
}
