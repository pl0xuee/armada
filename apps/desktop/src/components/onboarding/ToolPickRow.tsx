import { CircleAlert, CircleCheck, Clock, RefreshCw } from "lucide-react";
import { ProviderGlyph } from "@/components/ProviderGlyph";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/misc";
import type { AgentRun, RowState } from "@/lib/firstRun";
import { PROVIDERS } from "@/lib/providers";
import type { ProviderInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

/** One tool in the first-run step: a tick box while it's missing, then what its install is doing. */
export function ToolPickRow({
  info,
  state,
  run,
  ticked,
  onToggle,
  onRetry,
}: {
  info: ProviderInfo;
  state: RowState;
  run: AgentRun | undefined;
  ticked: boolean;
  onToggle: () => void;
  onRetry: () => void;
}) {
  const meta = PROVIDERS[info.provider];
  const id = `pick-${info.provider}`;
  const status =
    state === "ready"
      ? info.version
        ? `Ready · v${info.version}`
        : "Ready"
      : state === "queued"
        ? "Waiting for its turn…"
        : state === "installing"
          ? "Installing…"
          : state === "failed"
            ? (run?.reason ?? "It didn't install.")
            : "Not installed yet";
  return (
    <div
      className={cn(
        "relative flex items-center gap-3.5 overflow-hidden rounded-xl border bg-card p-3.5 edge transition-colors",
        state === "failed" ? "border-err/30" : state === "idle" && ticked ? "border-accent/30" : "border-line",
      )}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {state === "idle" ? (
          <Checkbox id={id} checked={ticked} onCheckedChange={onToggle} aria-label={`Install ${info.displayName}`} />
        ) : state === "ready" ? (
          <CircleCheck className="h-4 w-4 text-ok" aria-hidden />
        ) : state === "failed" ? (
          <CircleAlert className="h-4 w-4 text-err" aria-hidden />
        ) : state === "installing" ? (
          <Spinner />
        ) : (
          <Clock className="h-4 w-4 text-steel" aria-hidden />
        )}
      </span>
      <ProviderGlyph provider={info.provider} size="lg" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2">
          <label htmlFor={state === "idle" ? id : undefined} className="text-[14px] font-semibold tracking-tight">
            {info.displayName}
          </label>
          <span className="text-caption text-steel">
            {meta.tagline} · {meta.vendor}
          </span>
        </div>
        <p
          className={cn(
            "mt-0.5 text-caption leading-snug",
            state === "failed" ? "text-err" : state === "ready" ? "text-ok" : "text-muted",
          )}
          aria-live="polite"
        >
          {status}
        </p>
      </div>
      {state === "failed" && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          <RefreshCw /> Retry
        </Button>
      )}
    </div>
  );
}
