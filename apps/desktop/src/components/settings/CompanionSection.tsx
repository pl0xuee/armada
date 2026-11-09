import { CircleAlert, CircleCheck, Download, ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Badge, Spinner } from "@/components/ui/misc";
import { startCompanionInstall } from "@/lib/actions";
import { companionStatus, groupCompanions, installExplanation } from "@/lib/companions";
import type { CompanionInfo } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { useCompanions } from "@/store/companions";

/** Companion software: tools agents and projects commonly need, what each is for, and a one-click install. */
export function CompanionSection({ className }: { className?: string }) {
  const list = useCompanions((s) => s.list);
  const loading = useCompanions((s) => s.loading);
  const [confirming, setConfirming] = useState<CompanionInfo | null>(null);

  const refresh = () =>
    useCompanions
      .getState()
      .refresh()
      .catch((e: unknown) => toast.error("Couldn't check your tools", { description: errorMessage(e) }));
  useEffect(() => {
    void refresh();
  }, []);

  return (
    <section className={className} aria-labelledby="companion-title">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-[260px]">
          <h3 id="companion-title" className="text-[15px] font-semibold tracking-[-0.01em] text-fg">
            Companion software
          </h3>
          <p className="mt-1 text-body text-muted">
            Tools your agents and projects often need. Nothing is installed until you choose it.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={cn(loading && "animate-spin")} /> Check again
        </Button>
      </div>

      {list === null ? (
        <div className="flex items-center gap-2 rounded-xl border border-line bg-card p-4 text-body text-muted edge">
          <Spinner className="h-3.5 w-3.5" /> Looking at what is installed…
        </div>
      ) : (
        <div className="space-y-5">
          {groupCompanions(list).map((g) => (
            <div key={g.group}>
              <div className="eyebrow mb-1.5 px-1 text-steel">{g.group}</div>
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card edge">
                {g.items.map((c) => (
                  <CompanionRow key={c.id} c={c} onInstall={() => setConfirming(c)} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(o) => !o && setConfirming(null)}
        title={confirming ? `Install ${confirming.name}?` : ""}
        description={confirming && installExplanation(confirming)}
        confirmLabel="Install"
        onConfirm={() => {
          const c = confirming;
          setConfirming(null);
          if (c) void startCompanionInstall(c);
        }}
      >
        {confirming?.installCommand && (
          <div className="flex items-start gap-1 rounded-lg border border-line bg-code py-1 pl-3 pr-1">
            <code className="selectable min-w-0 flex-1 break-all py-1 font-mono text-meta text-muted">
              {confirming.installCommand}
            </code>
            <CopyButton text={confirming.installCommand} />
          </div>
        )}
      </ConfirmDialog>
    </section>
  );
}

function CompanionRow({ c, onInstall }: { c: CompanionInfo; onInstall: () => void }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3 max-sm:flex-col max-sm:gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-body font-semibold tracking-tight text-fg">{c.name}</span>
          {c.installed ? (
            <Badge tone="ok">
              <CircleCheck /> {companionStatus(c)}
            </Badge>
          ) : (
            <Badge tone={c.recommended ? "warn" : "neutral"}>
              <CircleAlert /> {companionStatus(c)}
            </Badge>
          )}
          {c.recommended && !c.installed && <Badge tone="accent">Recommended</Badge>}
        </div>
        <p className="mt-1 text-caption leading-relaxed text-muted">{c.purpose}</p>
      </div>
      {!c.installed && (
        <div className="shrink-0 max-sm:self-start">
          {c.installable ? (
            <Button
              size="sm"
              variant={c.recommended ? "primary" : "secondary"}
              onClick={onInstall}
              aria-label={`Install ${c.name}`}
            >
              <Download /> Install
            </Button>
          ) : (
            <Button asChild size="sm" variant="secondary">
              <a href={c.downloadUrl} rel="noreferrer noopener" aria-label={`Download ${c.name}`}>
                Download <ExternalLink />
              </a>
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
