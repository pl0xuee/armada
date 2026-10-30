import { CircleAlert, CircleCheck, Download, ExternalLink, RefreshCw } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { ProviderGlyph } from "@/components/ProviderGlyph";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/misc";
import { startInstall } from "@/lib/actions";
import { PROVIDERS } from "@/lib/providers";
import type { ProviderInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

export function providerReady(p: ProviderInfo) {
  return p.installed && (!p.adapterRequired || p.adapterInstalled);
}

export function anyMissing(providers: ProviderInfo[]) {
  return providers.some((p) => !providerReady(p));
}

/** Install / version status for one provider CLI. */
export function ProviderCard({
  info,
  compact,
  className,
}: {
  info: ProviderInfo;
  compact?: boolean;
  className?: string;
}) {
  const meta = PROVIDERS[info.provider];
  const ready = providerReady(info);
  const needsAdapter = info.installed && info.adapterRequired && !info.adapterInstalled;
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border bg-card edge transition-colors",
        ready ? "border-line" : "border-warn/25",
        className,
      )}
    >
      <div
        className="pointer-events-none absolute -left-16 -top-16 h-40 w-40 rounded-full opacity-[0.07] blur-2xl"
        style={{ background: meta.colorVar }}
        aria-hidden
      />
      <div className={cn("relative flex items-start gap-3.5", compact ? "p-3.5" : "p-4")}>
        <ProviderGlyph provider={info.provider} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-semibold tracking-tight">{info.displayName}</span>
            <span className="text-[12px] text-steel">
              {meta.tagline} · {meta.vendor}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {info.installed ? (
              <Badge tone="ok">
                <CircleCheck /> Installed{info.version ? ` · v${info.version}` : ""}
              </Badge>
            ) : (
              <Badge tone="warn">
                <CircleAlert /> Not installed
              </Badge>
            )}
            {info.managed && <Badge tone="accent">Bundled</Badge>}
            {info.adapterRequired && (
              <Badge tone={info.adapterInstalled ? "neutral" : "warn"}>
                ACP adapter {info.adapterInstalled ? "ready" : info.installed ? "needs update" : "missing"}
              </Badge>
            )}
            {!ready && !info.nodeAvailable && <Badge>Node.js will be downloaded privately</Badge>}
          </div>
          {needsAdapter && (
            <p className="mt-2 text-[12px] text-muted">The ACP adapter needs updating to the pinned version.</p>
          )}
          {!compact && info.path && (
            <p className="selectable mt-2 truncate font-mono text-[11.5px] text-steel">{info.path}</p>
          )}
          {!ready && (
            <div className="mt-3 flex items-center gap-1 rounded-lg border border-line bg-code py-1 pl-3 pr-1">
              <code className="selectable min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">
                {info.installCommand}
              </code>
              <CopyButton text={info.installCommand} />
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {!ready ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void startInstall(info.provider)}
              title={needsAdapter ? "The ACP adapter needs updating to the pinned version" : undefined}
            >
              {needsAdapter ? <RefreshCw /> : <Download />} {needsAdapter ? "Update" : "Install"}
            </Button>
          ) : (
            !compact && (
              <Button variant="ghost" size="sm" onClick={() => void startInstall(info.provider)}>
                <RefreshCw /> Update
              </Button>
            )
          )}
          {!compact && (
            <a
              href={info.docsUrl}
              rel="noreferrer noopener"
              className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-steel transition-colors hover:text-fg"
            >
              Docs <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
