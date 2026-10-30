import { CircleAlert, CircleCheck, Download, Loader2, RefreshCw, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ProviderGlyph } from "@/components/ProviderGlyph";
import { SectionHeader, SettingGroup, SettingRow } from "@/components/settings/SettingRow";
import { saveSettingsPatch } from "@/components/settings/settingsErrors";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Badge, Spinner } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { startInstall, startToolUpdate } from "@/lib/actions";
import { api } from "@/lib/api";
import { relativeTimeLong } from "@/lib/format";
import { PROVIDERS } from "@/lib/providers";
import {
  canInstall,
  canRollBack,
  lastChecked,
  SOURCE_LABEL,
  toolSource,
  toolStatus,
  updateCount,
  versionParts,
} from "@/lib/toolVersions";
import type { ProviderInfo, Settings } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { useApp } from "@/store/app";

/** Armada's own copies of Claude Code, Codex and Grok: where they come from, their versions, and updating. */
export function ToolsSection({ settings }: { settings: Settings }) {
  const providers = useApp((s) => s.providers);
  const [checking, setChecking] = useState(false);
  const checkedAt = lastChecked(providers);

  const check = async () => {
    setChecking(true);
    try {
      const list = await api.checkToolUpdates();
      useApp.getState().setProviders(list);
      const n = updateCount(list);
      if (n === 0) toast.success("Everything is up to date");
      else toast.info(n === 1 ? "1 update available" : `${n} updates available`);
    } catch (e) {
      toast.error("Couldn't check for updates", { description: errorMessage(e) });
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <SectionHeader
        title="Agent tools"
        description="Armada installs and updates its own copies of Claude Code, Codex and Grok, so signing in and running agents never depend on what is installed on this computer."
      />
      <SettingGroup className="mb-5">
        <SettingRow
          title="Check for updates"
          description={checkedAt ? `Last checked ${relativeTimeLong(checkedAt)}` : "Last checked: never"}
        >
          <Button size="sm" variant="secondary" onClick={check} disabled={checking}>
            {checking ? <Spinner /> : <RefreshCw />} {checking ? "Checking…" : "Check now"}
          </Button>
        </SettingRow>
        <SettingRow
          title="Update automatically"
          htmlFor="t-auto"
          description="Checks every few hours and installs new versions when no agent is mid-turn. A version that doesn't start is rolled back automatically."
        >
          <Switch
            id="t-auto"
            checked={settings.autoUpdateTools}
            onCheckedChange={(v) =>
              void saveSettingsPatch({ autoUpdateTools: v }, (message) =>
                toast.error("Couldn't save settings", { description: message }),
              )
            }
          />
        </SettingRow>
      </SettingGroup>
      <div className="space-y-3">
        {providers
          .filter((p) => p.provider === "claude" || p.provider === "codex" || p.provider === "grok")
          .map((p) => (
            <ToolCard key={p.provider} info={p} />
          ))}
      </div>
      <p className="mt-4 px-0.5 text-[12px] text-steel">
        Updates come from the official npm registry. Armada was tested with the versions shown as Tested and can go back
        to them at any time.
      </p>
    </>
  );
}

function ToolCard({ info }: { info: ProviderInfo }) {
  const meta = PROVIDERS[info.provider];
  const source = toolSource(info);
  const status = toolStatus(info);
  const versions = versionParts(info);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const rollBack = canRollBack(info);

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border bg-card edge transition-colors",
        status.kind === "uptodate" ? "border-line" : status.kind === "setup" ? "border-line" : "border-warn/25",
      )}
    >
      <div
        className="pointer-events-none absolute -left-16 -top-16 h-40 w-40 rounded-full opacity-[0.07] blur-2xl"
        style={{ background: meta.colorVar }}
        aria-hidden
      />
      <div className="relative flex flex-wrap items-start gap-x-3.5 gap-y-3 p-4">
        <ProviderGlyph provider={info.provider} size="lg" />
        <div className="min-w-0 flex-1 basis-[240px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-semibold tracking-tight">{meta.name}</span>
            <span className="text-[12px] text-steel">{meta.tagline}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={source === "bundled" ? "accent" : "neutral"}>{SOURCE_LABEL[source]}</Badge>
            <StatusChip status={status} />
          </div>
          {versions.length > 0 && (
            <p className="selectable mt-2 text-[12px] text-muted tabular">{versions.join(" · ")}</p>
          )}
          {source === "system" && (
            <p className="mt-1.5 text-[12px] text-muted">Armada will install its own copy shortly.</p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {info.managed && info.updateAvailable && (
            <Button size="sm" variant="primary" onClick={() => void startToolUpdate(info.provider)}>
              <Download /> Update{info.latestVersion ? ` to ${info.latestVersion}` : ""}
            </Button>
          )}
          {canInstall(info) && (
            <Button size="sm" variant="secondary" onClick={() => void startInstall(info.provider)}>
              <Download /> Install
            </Button>
          )}
          {rollBack && (
            <Button size="sm" variant="ghost" onClick={() => setConfirmRollback(true)}>
              <Undo2 /> Roll back to {info.testedVersion}
            </Button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmRollback}
        onOpenChange={setConfirmRollback}
        title={`Roll back ${meta.short} to ${info.testedVersion}?`}
        description={`This installs ${info.testedVersion}, the version this Armada was tested with, in place of ${info.managedVersion}. Automatic updates may move it forward again when a newer release is found.`}
        confirmLabel="Roll back"
        onConfirm={() => {
          setConfirmRollback(false);
          void startToolUpdate(info.provider, true);
        }}
      />
    </div>
  );
}

function StatusChip({ status }: { status: ReturnType<typeof toolStatus> }) {
  switch (status.kind) {
    case "uptodate":
      return (
        <Badge tone="ok">
          <CircleCheck /> {status.label}
        </Badge>
      );
    case "update":
      return (
        <Badge tone="warn">
          <RefreshCw /> {status.label}
        </Badge>
      );
    case "setup":
      return (
        <Badge>
          <Loader2 className="animate-spin" /> {status.label}
        </Badge>
      );
    case "missing":
      return (
        <Badge tone="warn">
          <CircleAlert /> {status.label}
        </Badge>
      );
  }
}
