import {
  ExternalLink,
  Eye,
  EyeOff,
  Link2,
  QrCode,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Trash2,
  Unplug,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/CopyButton";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Select, type SelectOption } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { useNow } from "@/hooks/useNow";
import { api } from "@/lib/api";
import { openExternal } from "@/lib/external";
import { relativeTimeLong } from "@/lib/format";
import type {
  LanAddress,
  RemoteDevice,
  RemoteSettings,
  RemoteStatus,
  Settings,
  ShareLink,
  TailscaleStatus,
} from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store/app";
import { pollRemoteStatus } from "./remoteStatus";
import { FieldError } from "./FieldError";
import { fieldErrorId, saveSettingsPatch, useFieldError } from "./settingsErrors";
import { useCommitOnUnmount } from "./useCommitOnUnmount";
import { SectionHeader, SettingGroup, SettingRow } from "./SettingRow";

const SECURITY_COPY =
  "Off by default. Tailscale is the safest way in: traffic is encrypted and only your own devices can connect, at home or away, without opening anything on your network. On your local network (LAN), traffic is not encrypted (plain HTTP): anyone on the same Wi-Fi could read or tamper with it, so use it only on networks you trust. The pairing code in the QR works once and expires after 5 minutes; each paired device gets its own key you can revoke below. Share links are read-only, limited to one agent, and expire.";

type Reach = "local" | "tailscale" | "lan";

const REACH_HELP: Record<Reach, string> = {
  local: "Only this computer can connect (localhost).",
  tailscale: "Your devices on Tailscale, from anywhere. Encrypted; nothing is opened on your network.",
  lan: "Phones and computers on this Wi-Fi. Not encrypted.",
};

const KIND_LABEL: Record<LanAddress["kind"], string> = {
  lan: "Wi-Fi / Ethernet",
  tailscale: "Tailscale",
  vpn: "VPN",
  virtual: "Virtual network",
};

const AUTO = "auto";

/** "Automatic" plus each address; a saved pick this computer no longer has stays listed. */
function networkOptions(addresses: LanAddress[], saved: string | null | undefined): SelectOption[] {
  const best = addresses[0];
  const options: SelectOption[] = [
    {
      value: AUTO,
      label: "Automatic",
      description: best ? `${KIND_LABEL[best.kind]} · ${best.ip}` : "Wi-Fi or Ethernet when connected",
    },
    ...addresses.map((a) => ({ value: a.ip, label: `${KIND_LABEL[a.kind]} · ${a.ip}`, description: a.interface })),
  ];
  if (saved && !addresses.some((a) => a.ip === saved)) {
    options.push({ value: saved, label: saved, description: "Not connected right now", disabled: true });
  }
  return options;
}

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
  /** True while the server (re)starts after a change: show "Starting…", not a stale/error state. */
  const [starting, setStarting] = useState(false);
  const [confirmLan, setConfirmLan] = useState(false);
  const [showPairing, setShowPairing] = useState(false);

  // Follow the saved port, except while a rejected value is shown with its error (so it can be fixed).
  const keepTyped = useRef(false);
  useEffect(() => {
    if (keepTyped.current) return;
    setPort(String(remote.port));
  }, [remote.port]);

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

  // The pairing code is single use: keep the QR, the code's expiry and the device list current.
  const live = !!status?.running;
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [live, refresh]);

  /** Persist remote settings (the backend starts/stops/restarts the server), then re-read status. */
  const apply = async (patch: Partial<RemoteSettings>) => {
    const current = useApp.getState().settings;
    if (!current) return;
    setApplying(true);
    // Validation errors (e.g. the port) land inline on their field; the store rolls back.
    keepTyped.current = "port" in patch;
    const ok = await saveSettingsPatch({ remote: { ...current.remote, ...patch } }, (message) =>
      toast.error("Couldn't update remote access", { description: message }),
    );
    // Release on the next tick, after the rollback re-render has been skipped.
    setTimeout(() => (keepTyped.current = !ok && "port" in patch), 0);
    if (!ok) {
      setApplying(false);
      return;
    }
    setStarting(true);
    try {
      await pollRemoteStatus((st, settled) => {
        setStatus(st);
        if (settled) setStarting(false);
      });
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
      setStarting(false);
    }
    setApplying(false);
  };

  const reach: Reach = remote.tailscale ? "tailscale" : remote.lan ? "lan" : "local";

  const portBackendError = useFieldError("port");
  const parsedPort = validPort(port);
  const portError = parsedPort === null ? "Use a port between 1024 and 65535." : null;
  const commitPort = () => {
    if (parsedPort === null || parsedPort === remote.port) return;
    void apply({ port: parsedPort });
  };
  useCommitOnUnmount(commitPort);

  const unpair = async () => {
    setRotating(true);
    try {
      setStatus(await api.remoteRotateToken());
      toast.success("All devices unpaired", { description: "Scan the pairing code to pair again." });
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
          <SettingRow title="Reachable from" description={REACH_HELP[reach]}>
            <Segmented<Reach>
              aria-label="Reachable from"
              value={reach}
              onChange={(v) => {
                if (v === reach) return;
                // Opening the server to the network is a real exposure: confirm it.
                if (v === "lan") setConfirmLan(true);
                else void apply({ lan: false, tailscale: v === "tailscale" });
              }}
              options={[
                { value: "local", label: "This computer", disabled: applying },
                { value: "tailscale", label: "Tailscale", disabled: applying },
                { value: "lan", label: "Local network", disabled: applying },
              ]}
            />
          </SettingRow>
          <SettingRow
            title="Port"
            description={portError ?? "Change it if something else on this computer already uses it."}
            htmlFor="remote-port"
          >
            <div className="flex flex-col items-end">
              <Input
                id="remote-port"
                inputMode="numeric"
                value={port}
                disabled={applying}
                aria-invalid={!!portError || !!portBackendError}
                aria-describedby={portBackendError ? fieldErrorId("port") : undefined}
                onChange={(e) => setPort(e.target.value)}
                onBlur={commitPort}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitPort();
                  if (e.key === "Escape") {
                    keepTyped.current = false;
                    setPort(String(remote.port));
                  }
                }}
                className={cn(
                  "h-8 w-[96px] text-right font-mono text-[12.5px] tabular",
                  (portError || portBackendError) && "border-err/60 focus:border-err/70 focus:ring-err/15",
                )}
              />
              <FieldError field="port" />
            </div>
          </SettingRow>
          {remote.lan && status && (status.lanAddresses.length > 1 || remote.lanAddress) && (
            <SettingRow
              title="Network"
              description={networkDescription(status, remote.lanAddress)}
              htmlFor="remote-network"
            >
              <Select
                id="remote-network"
                aria-label="Network"
                className="h-8 w-[240px]"
                disabled={applying}
                value={remote.lanAddress ?? AUTO}
                onValueChange={(v) => void apply({ lanAddress: v === AUTO ? null : v })}
                options={networkOptions(status.lanAddresses, remote.lanAddress)}
              />
            </SettingRow>
          )}
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
            <StatusCard status={status} starting={starting} />
            {status.running && status.tailscale && (
              <TailscaleCard tailscale={status.tailscale} onRecheck={() => void refresh()} />
            )}
            {status.running && status.firewall && <FirewallCard firewall={status.firewall} />}
            {status.running && status.pairingUrl && (
              <PairingCard
                status={status}
                rotating={rotating}
                shown={showPairing}
                onShow={setShowPairing}
                onUnpair={() => setConfirmUnpair(true)}
              />
            )}
            <DevicesGroup
              devices={status.devices}
              onChanged={(st) => setStatus(st)}
              onUnpairAll={() => setConfirmUnpair(true)}
              rotating={rotating}
            />
            <SharesGroup shares={status.shares} enabled={status.enabled} onChanged={() => void refresh()} />
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmLan}
        onOpenChange={setConfirmLan}
        title="Allow devices on your network?"
        description={
          <>
            Anyone on this network who scans the pairing code while it's shown can control your agents, and traffic on
            the local network isn't encrypted. Use it on networks you trust, not on public Wi-Fi; Tailscale is the safer
            choice. Armada refuses to listen on a public address.
          </>
        }
        confirmLabel="Allow network access"
        onConfirm={() => {
          setConfirmLan(false);
          void apply({ lan: true, tailscale: false });
        }}
      />

      <ConfirmDialog
        open={confirmUnpair}
        onOpenChange={setConfirmUnpair}
        danger
        busy={rotating}
        title="Unpair all devices?"
        description="Every paired phone and browser is signed out right away. Share links stay active."
        confirmLabel="Unpair all"
        onConfirm={unpair}
      />
    </>
  );
}

/** The address in use, warning when phones on the Wi-Fi can't reach it. */
function networkDescription(status: RemoteStatus, saved: string | null | undefined): string {
  const host = status.url ? new URL(status.url).hostname : null;
  const current = status.lanAddresses.find((a) => a.ip === host);
  if (current && (current.kind === "vpn" || current.kind === "virtual")) {
    return "Phones on your Wi-Fi can't reach this address. Pick Wi-Fi / Ethernet, or connect the phone to the same VPN.";
  }
  if (saved && !status.lanAddresses.some((a) => a.ip === saved)) {
    return "The address you picked isn't connected, so Armada is using the best one available.";
  }
  return "Which of this computer's addresses phones on your network connect to.";
}

/** Linux firewalls drop the phone's connections silently: Safari just shows a blank page. */
function FirewallCard({ firewall }: { firewall: NonNullable<RemoteStatus["firewall"]> }) {
  return (
    <div role="note" className="flex gap-3 rounded-xl border border-warn/30 bg-warn/[0.06] px-4 py-3">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">This computer's firewall may block your phone</div>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">
          {firewall.name} is on and doesn't allow Armada's port, so a phone that scans the code waits on a blank page.
          Allow devices on your network by running this in a terminal:
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code className="selectable min-w-0 flex-1 truncate rounded-lg border border-line bg-base/60 px-2.5 py-1.5 font-mono text-[12px] text-fg/90">
            {firewall.command}
          </code>
          <CopyButton text={firewall.command} />
        </div>
      </div>
    </div>
  );
}

function StatusCard({ status, starting }: { status: RemoteStatus; starting: boolean }) {
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
  if (status.error && !starting) {
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
        {status.running ? (
          <span className="h-1.5 w-1.5 rounded-full bg-ok" />
        ) : (
          <Spinner className="h-3 w-3 text-current" />
        )}
        {status.running ? "Running" : "Starting…"}
      </span>
      {status.url && <span className="selectable min-w-0 truncate font-mono text-[12px] text-fg/90">{status.url}</span>}
      <span className="ml-auto text-[12px] text-steel">
        {status.lan || status.tailscale?.state === "on" ? lanLabel(status) : "This computer only"}
      </span>
    </div>
  );
}

/** Setup steps until Tailscale Serve is sharing Armada, then what the phone needs. */
function TailscaleCard({ tailscale, onRecheck }: { tailscale: TailscaleStatus; onRecheck: () => void }) {
  if (tailscale.state === "on") {
    return (
      <div className="flex gap-3 rounded-xl border border-line bg-card/60 px-4 py-3 edge">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
        <p className="text-[12.5px] leading-relaxed text-muted">
          Shared over Tailscale with HTTPS. Your phone needs the Tailscale app, signed in to the same account; then scan
          the pairing code below.
        </p>
      </div>
    );
  }
  if (tailscale.state === "checking") {
    return (
      <div role="status" className="flex items-center gap-2.5 rounded-xl border border-line bg-card/60 px-4 py-3 edge">
        <Spinner className="h-3.5 w-3.5 text-steel" />
        <span className="text-[12.5px] text-muted">Setting up Tailscale…</span>
      </div>
    );
  }
  const title =
    tailscale.state === "notInstalled"
      ? "Install Tailscale"
      : tailscale.state === "notConnected"
        ? "Connect Tailscale on this computer"
        : tailscale.state === "needsOperator"
          ? "Let Armada use Tailscale Serve"
          : tailscale.state === "needsHttps"
            ? "Turn on HTTPS for your tailnet"
            : "Tailscale couldn't share Armada";
  return (
    <div role="note" className="flex gap-3 rounded-xl border border-warn/30 bg-warn/[0.06] px-4 py-3">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{title}</div>
        {tailscale.message && (
          <p className="selectable mt-0.5 text-[12.5px] leading-relaxed text-muted">{tailscale.message}</p>
        )}
        {tailscale.command && (
          <div className="mt-2 flex items-center gap-2">
            <code className="selectable min-w-0 flex-1 truncate rounded-lg border border-line bg-base/60 px-2.5 py-1.5 font-mono text-[12px] text-fg/90">
              {tailscale.command}
            </code>
            <CopyButton text={tailscale.command} />
          </div>
        )}
        <div className="mt-2.5 flex flex-wrap gap-2">
          {tailscale.link && (
            <Button size="sm" variant="secondary" onClick={() => void openExternal(tailscale.link as string)}>
              <ExternalLink /> {tailscale.state === "notInstalled" ? "Download Tailscale" : "Open"}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onRecheck}>
            <RefreshCw /> Check again
          </Button>
        </div>
      </div>
    </div>
  );
}

function lanLabel(status: RemoteStatus): string {
  if (status.tailscale?.state === "on") return "Tailscale";
  const host = status.url ? new URL(status.url).hostname : null;
  const current = status.lanAddresses.find((a) => a.ip === host);
  return current ? `${KIND_LABEL[current.kind]} (${current.interface})` : "LAN";
}

function PairingCard({
  status,
  rotating,
  shown,
  onShow,
  onUnpair,
}: {
  status: RemoteStatus;
  rotating: boolean;
  /** The QR and link let a device pair with full control: keep them hidden until asked for (screen sharing, shoulder surfing). */
  shown: boolean;
  onShow: (shown: boolean) => void;
  onUnpair: () => void;
}) {
  const url = status.pairingUrl ?? "";
  if (!shown) {
    return (
      <section
        aria-label="Pair a device"
        className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-card px-4 py-3.5 edge"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-raised text-steel">
          <QrCode className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">Pair your phone</div>
          <div className="text-[12px] text-muted">
            The pairing code is hidden so it doesn't show up in screen shares. It works once and expires after 5
            minutes.
          </div>
        </div>
        <Button size="sm" variant="secondary" onClick={() => onShow(true)}>
          <Eye /> Show pairing code
        </Button>
        <Button size="sm" variant="ghost" disabled={rotating} onClick={onUnpair}>
          {rotating ? <Spinner className="h-3.5 w-3.5" /> : <Unplug className="!h-3.5 !w-3.5" />}
          Unpair all
        </Button>
      </section>
    );
  }
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
        <div className="flex items-center gap-2">
          <h3 className="text-[14px] font-semibold tracking-tight">Pair your phone</h3>
          <Button size="xs" variant="ghost" className="ml-auto" onClick={() => onShow(false)}>
            <EyeOff className="!h-3.5 !w-3.5" /> Hide
          </Button>
        </div>
        <ol className="mt-2 space-y-1 text-[12.5px] text-muted">
          <li>
            <span className="mr-1.5 text-steel tabular">1.</span>Open the camera on your phone.
          </li>
          <li>
            <span className="mr-1.5 text-steel tabular">2.</span>Scan the code and open the link. It works once, for 5
            minutes.
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
  // Titles of the shared agents only (not the whole agent map, which changes on every stream tick).
  const titles = useApp(useShallow((s) => shares.map((sh) => s.agents[sh.agentId]?.title ?? null)));
  const [revoking, setRevoking] = useState<string | null>(null);

  const revoke = async (link: ShareLink) => {
    setRevoking(link.id);
    try {
      await api.revokeShareLink(link.id);
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
      description="Read-only live views of a single agent: messages and a tool outline, no command output, files or local paths. Create one from an agent's menu: Share live view…"
    >
      {shares.length === 0 ? (
        <div className="flex items-center gap-3 px-4 py-4 text-[12.5px] text-steel">
          <Link2 className="h-4 w-4 shrink-0" />
          {enabled ? "No active share links." : "Share links work while remote access is on."}
        </div>
      ) : (
        shares.map((s) => {
          const title = s.agentTitle ?? titles[shares.indexOf(s)] ?? "Deleted agent";
          return (
            <div key={s.id} className="flex items-center gap-3 px-4 py-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-raised text-steel">
                <Link2 className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{title}</div>
                <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-steel">
                  <span className="shrink-0">Created {relativeTimeLong(s.createdAt, now)}</span>
                  <span className="text-line-strong">·</span>
                  <span className="shrink-0">Expires {new Date(s.expiresAt).toLocaleString()}</span>
                </div>
              </div>
              <Tooltip content="Revoke link">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Revoke share link for ${title}`}
                  disabled={revoking === s.id}
                  onClick={() => void revoke(s)}
                  className="hover:text-err"
                >
                  {revoking === s.id ? <Spinner className="h-3.5 w-3.5" /> : <Trash2 className="!h-3.5 !w-3.5" />}
                </Button>
              </Tooltip>
            </div>
          );
        })
      )}
    </SettingGroup>
  );
}

function DevicesGroup({
  devices,
  onChanged,
  onUnpairAll,
  rotating,
}: {
  devices: RemoteDevice[];
  onChanged: (status: RemoteStatus) => void;
  onUnpairAll: () => void;
  rotating: boolean;
}) {
  const now = useNow();
  const [revoking, setRevoking] = useState<string | null>(null);

  const revoke = async (device: RemoteDevice) => {
    setRevoking(device.id);
    try {
      onChanged(await api.remoteRevokeDevice(device.id));
      toast("Device unpaired", { description: `${device.name} lost access immediately.` });
    } catch (e) {
      toast.error("Couldn't unpair the device", { description: errorMessage(e) });
    } finally {
      setRevoking(null);
    }
  };

  return (
    <SettingGroup
      title="Paired devices"
      description="Each phone has its own key. Revoke one to sign that device out right away."
    >
      {devices.length === 0 ? (
        <div className="flex items-center gap-3 px-4 py-4 text-[12.5px] text-steel">
          <Smartphone className="h-4 w-4 shrink-0" />
          No paired devices. Scan the pairing code with your phone.
        </div>
      ) : (
        <>
          {devices.map((d) => (
            <div key={d.id} className="flex items-center gap-3 px-4 py-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-raised text-steel">
                <Smartphone className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{d.name}</div>
                <div className="text-[11.5px] text-steel">
                  {d.lastSeen > 0 ? `Last seen ${relativeTimeLong(d.lastSeen, now)}` : "Not seen yet"} · paired{" "}
                  {relativeTimeLong(d.createdAt, now)}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Revoke ${d.name}`}
                disabled={revoking === d.id}
                onClick={() => void revoke(d)}
                className="hover:text-err"
              >
                {revoking === d.id ? <Spinner className="h-3.5 w-3.5" /> : <Trash2 className="!h-3.5 !w-3.5" />}
                Revoke
              </Button>
            </div>
          ))}
          <div className="flex justify-end px-4 py-2.5">
            <Button size="sm" variant="danger" disabled={rotating} onClick={onUnpairAll}>
              {rotating ? <Spinner className="h-3.5 w-3.5 text-current" /> : <Unplug className="!h-3.5 !w-3.5" />}
              Unpair all devices
            </Button>
          </div>
        </>
      )}
    </SettingGroup>
  );
}
