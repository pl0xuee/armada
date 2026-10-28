import { Link2, RefreshCw, ShieldCheck, Smartphone, Trash2, Unplug } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/CopyButton";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { useNow } from "@/hooks/useNow";
import { api } from "@/lib/api";
import { relativeTimeLong } from "@/lib/format";
import type { RemoteSettings, RemoteStatus, Settings, ShareLink } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { useApp } from "@/store/app";
import { SectionHeader, SettingGroup, SettingRow } from "./SettingRow";

const SECURITY_COPY =
  "Off by default. With LAN access on, traffic isn't encrypted: use it on networks you trust, or over a VPN such as Tailscale. Anyone with the pairing link has full control; share links are read-only and limited to one agent.";

function validPort(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= 1024 && n <= 65535 ? n : null;
}

export function RemoteSection({ settings }: { settings: Settings }) {
  const remote = settings.remote;
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [port, setPort] = useState(String(remote.port));
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [rotating, setRotating] = useState(false);

  useEffect(() => setPort(String(remote.port)), [remote.port]);

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

  /** Persist remote settings (the backend starts/stops/restarts the server), then re-read status. */
  const apply = async (patch: Partial<RemoteSettings>) => {
    const current = useApp.getState().settings;
    if (!current) return;
    setApplying(true);
    try {
      await useApp.getState().setSettings({ ...current, remote: { ...current.remote, ...patch } });
    } catch (e) {
      toast.error("Couldn't update remote access", { description: errorMessage(e) });
    }
    await refresh();
    setApplying(false);
  };

  const parsedPort = validPort(port);
  const portError = parsedPort === null ? "Use a port between 1024 and 65535." : null;
  const commitPort = () => {
    if (parsedPort === null || parsedPort === remote.port) return;
    void apply({ port: parsedPort });
  };

  const unpair = async () => {
    setRotating(true);
    try {
      setStatus(await api.remoteRotateToken());
      toast.success("All devices unpaired", { description: "Scan the new code to pair again." });
    } catch (e) {
      toast.error("Couldn't unpair devices", { description: errorMessage(e) });
    } finally {
      setRotating(false);
      setConfirmUnpair(false);
    }
  };

  return (
    <>
      <SectionHeader
        title="Remote & mobile"
        description="Check on agents, approve requests and send prompts from your phone or another computer."
      />

      <div className="space-y-6">
        <div className="flex gap-3 rounded-xl border border-line bg-card/60 px-4 py-3 edge">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <p className="text-[12.5px] leading-relaxed text-muted">{SECURITY_COPY}</p>
        </div>

        <SettingGroup>
          <SettingRow
            title="Remote access"
            description="Runs a small web server inside Armada for the mobile companion and share links."
            htmlFor="remote-enabled"
          >
            {applying && (
              <span className="flex items-center gap-1.5 text-[12px] text-steel" role="status">
                <Spinner className="h-3.5 w-3.5" /> Applying…
              </span>
            )}
            <Switch
              id="remote-enabled"
              checked={remote.enabled}
              disabled={applying}
              onCheckedChange={(v) => void apply({ enabled: v })}
            />
          </SettingRow>
          <SettingRow
            title="Allow devices on my network (LAN)"
            description={
              remote.lan
                ? "Reachable from phones and computers on this network."
                : "Only this computer can connect (localhost)."
            }
            htmlFor="remote-lan"
          >
            <Switch
              id="remote-lan"
              checked={remote.lan}
              disabled={applying}
              onCheckedChange={(v) => void apply({ lan: v })}
            />
          </SettingRow>
          <SettingRow
            title="Port"
            description={portError ?? "Change it if something else on this computer already uses it."}
            htmlFor="remote-port"
          >
            <Input
              id="remote-port"
              inputMode="numeric"
              value={port}
              disabled={applying}
              aria-invalid={!!portError}
              onChange={(e) => setPort(e.target.value)}
              onBlur={commitPort}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitPort();
                if (e.key === "Escape") setPort(String(remote.port));
              }}
              className={cn(
                "h-8 w-[96px] text-right font-mono text-[12.5px] tabular",
                portError && "border-err/60 focus:border-err/70 focus:ring-err/15",
              )}
            />
          </SettingRow>
        </SettingGroup>

        {loadError ? (
          <div role="alert" className="flex items-center gap-3 rounded-xl border border-err/30 bg-err/[0.06] px-4 py-3">
            <p className="min-w-0 flex-1 text-[12.5px] text-err">
              Couldn't read the remote server status: <span className="font-mono text-[12px]">{loadError}</span>
            </p>
            <Button size="sm" variant="secondary" onClick={() => void refresh()}>
              <RefreshCw /> Retry
            </Button>
          </div>
        ) : !status ? (
          <Skeleton className="h-[148px] rounded-xl" />
        ) : (
          <>
            <StatusCard status={status} />
            {status.running && status.pairingUrl && (
              <PairingCard status={status} rotating={rotating} onUnpair={() => setConfirmUnpair(true)} />
            )}
            <SharesGroup shares={status.shares} enabled={status.enabled} onChanged={() => void refresh()} />
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmUnpair}
        onOpenChange={setConfirmUnpair}
        danger
        busy={rotating}
        title="Unpair all devices?"
        description="Every paired phone and browser is signed out right away and the old pairing link stops working. Share links stay active."
        confirmLabel="Unpair all"
        onConfirm={unpair}
      />
    </>
  );
}

function StatusCard({ status }: { status: RemoteStatus }) {
  if (!status.enabled) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-dashed border-line-strong bg-card/40 px-4 py-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-raised text-steel">
          <Smartphone className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-medium">Remote access is off</div>
          <div className="text-[12px] text-muted">Turn it on to pair your phone with a QR code.</div>
        </div>
      </div>
    );
  }
  if (status.error) {
    return (
      <div role="alert" className="flex items-start gap-3 rounded-xl border border-err/30 bg-err/[0.06] px-4 py-3.5">
        <Unplug className="mt-0.5 h-4 w-4 shrink-0 text-err" />
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-err">The remote server couldn't start</div>
          <p className="selectable mt-0.5 font-mono text-[12px] text-err/90">{status.error}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-card px-4 py-3 edge">
      <span
        className={cn(
          "inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-[11.5px] font-medium",
          status.running ? "border-ok/30 bg-ok/10 text-ok" : "border-line-strong bg-raised text-muted",
        )}
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", status.running ? "bg-ok" : "bg-steel")} />
        {status.running ? "Running" : "Starting…"}
      </span>
      {status.url && <span className="selectable min-w-0 truncate font-mono text-[12px] text-fg/90">{status.url}</span>}
      <span className="ml-auto text-[12px] text-steel">{status.lan ? "LAN" : "This computer only"}</span>
    </div>
  );
}

function PairingCard({
  status,
  rotating,
  onUnpair,
}: {
  status: RemoteStatus;
  rotating: boolean;
  onUnpair: () => void;
}) {
  const url = status.pairingUrl ?? "";
  return (
    <section
      aria-label="Pair a device"
      className="flex flex-col gap-5 rounded-xl border border-line bg-card p-4 edge sm:flex-row sm:items-center"
    >
      <div className="flex shrink-0 justify-center">
        {status.qrSvg ? (
          <img
            src={`data:image/svg+xml;utf8,${encodeURIComponent(status.qrSvg)}`}
            alt="QR code for the pairing link"
            width={168}
            height={168}
            className="rounded-xl bg-white p-2.5 shadow-[0_8px_30px_-10px_rgba(0,0,0,0.6)]"
          />
        ) : (
          <div className="flex h-[168px] w-[168px] items-center justify-center rounded-xl border border-dashed border-line-strong text-[12px] text-steel">
            No QR code
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-[14px] font-semibold tracking-tight">Pair your phone</h3>
        <ol className="mt-2 space-y-1 text-[12.5px] text-muted">
          <li>
            <span className="mr-1.5 text-steel tabular">1.</span>Open the camera on your phone.
          </li>
          <li>
            <span className="mr-1.5 text-steel tabular">2.</span>Scan the code and open the link.
          </li>
          <li>
            <span className="mr-1.5 text-steel tabular">3.</span>Add it to your home screen for one-tap access.
          </li>
        </ol>
        <div className="mt-3 flex min-w-0 items-center gap-1 rounded-lg border border-line bg-base/50 py-1 pl-2.5 pr-1">
          <span className="selectable min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg/90" title={url}>
            {url}
          </span>
          <CopyButton text={url} label="Copy link" />
        </div>
        {!status.lan && (
          <p className="mt-2 text-[12px] text-steel">
            Only this computer can open it. Turn on LAN access to pair a phone.
          </p>
        )}
        <Button size="sm" variant="danger" className="mt-3" disabled={rotating} onClick={onUnpair}>
          {rotating ? <Spinner className="h-3.5 w-3.5 text-current" /> : <Unplug className="!h-3.5 !w-3.5" />}
          Unpair all devices
        </Button>
      </div>
    </section>
  );
}

function SharesGroup({ shares, enabled, onChanged }: { shares: ShareLink[]; enabled: boolean; onChanged: () => void }) {
  const now = useNow();
  const agents = useApp((s) => s.agents);
  const [revoking, setRevoking] = useState<string | null>(null);

  const revoke = async (link: ShareLink) => {
    setRevoking(link.token);
    try {
      await api.revokeShareLink(link.token);
      toast("Share link revoked", { description: link.agentTitle ?? undefined });
      onChanged();
    } catch (e) {
      toast.error("Couldn't revoke the link", { description: errorMessage(e) });
    } finally {
      setRevoking(null);
    }
  };

  return (
    <SettingGroup
      title="Share links"
      description="Read-only live views of a single agent. Create one from an agent's menu: Share live view…"
    >
      {shares.length === 0 ? (
        <div className="flex items-center gap-3 px-4 py-4 text-[12.5px] text-steel">
          <Link2 className="h-4 w-4 shrink-0" />
          {enabled ? "No active share links." : "Share links work while remote access is on."}
        </div>
      ) : (
        shares.map((s) => {
          const title = s.agentTitle ?? agents[s.agentId]?.title ?? "Deleted agent";
          return (
            <div key={s.token} className="flex items-center gap-3 px-4 py-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-raised text-steel">
                <Link2 className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{title}</div>
                <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-steel">
                  <span className="shrink-0">Created {relativeTimeLong(s.createdAt, now)}</span>
                  {s.url && (
                    <>
                      <span className="text-line-strong">·</span>
                      <span className="selectable min-w-0 truncate font-mono text-[11px]">{s.url}</span>
                    </>
                  )}
                </div>
              </div>
              {s.url && <CopyButton text={s.url} label="Copy" />}
              <Tooltip content="Revoke link">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Revoke share link for ${title}`}
                  disabled={revoking === s.token}
                  onClick={() => void revoke(s)}
                  className="hover:text-err"
                >
                  {revoking === s.token ? <Spinner className="h-3.5 w-3.5" /> : <Trash2 className="!h-3.5 !w-3.5" />}
                </Button>
              </Tooltip>
            </div>
          );
        })
      )}
    </SettingGroup>
  );
}
