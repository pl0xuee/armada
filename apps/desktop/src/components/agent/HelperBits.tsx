import { AlertTriangle, Check, Clock, GitFork, Columns2, RefreshCw } from "lucide-react";
import { attempt } from "@/lib/actions";
import { api } from "@/lib/api";
import { relativeTimeLong } from "@/lib/format";
import { syncPresentation, type SyncTone } from "@/lib/helpers";
import type { Agent } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useIdentity } from "@/hooks/useIdentity";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { Button } from "../ui/button";
import { Spinner } from "../ui/misc";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Tooltip } from "../ui/tooltip";

const TONE: Record<SyncTone, string> = {
  ok: "border-ok/30 bg-ok/10 text-ok",
  busy: "border-accent/30 bg-accent/10 text-accent",
  wait: "border-line-strong bg-card/60 text-muted",
  warn: "border-warn/40 bg-warn/12 text-warn",
};

/** Main agent of a helper plus its short provider name; null for plain agents. */
function useMain(agent: Agent): { main: Agent; name: string } | null {
  const main = useApp((s) => (agent.parentId ? s.agents[agent.parentId] : undefined));
  const identity = useIdentity(main?.provider ?? agent.provider, main?.customAgentId ?? null);
  return main ? { main, name: identity.short } : null;
}

async function syncNow(agent: Agent) {
  const updated = await attempt("Couldn't sync the helper", () => api.syncHelper(agent.id));
  if (updated) useApp.getState().upsertAgent(updated);
}

async function askMain(agent: Agent, mainName: string) {
  await attempt(`Couldn't ask ${mainName} to merge`, () => api.askMainToMerge(agent.id));
}

/** "Helper of <main>" line under a helper's title; opens the main agent. */
export function HelperOfLine({ agent }: { agent: Agent }) {
  const ctx = useMain(agent);
  if (!ctx) return null;
  return (
    <button
      type="button"
      onClick={() => useUi.getState().openAgent(ctx.main.id)}
      className="flex min-w-0 shrink items-center gap-1.5 text-left text-[11.5px] leading-none text-steel transition-colors hover:text-fg"
    >
      <GitFork className="h-3 w-3 shrink-0 text-accent" />
      <span className="shrink-0">Helper of</span>
      <span className="min-w-0 truncate text-muted">{ctx.main.title}</span>
    </button>
  );
}

/** Sync state of a helper with its main agent; the popover holds the actions. */
export function SyncChip({ agent }: { agent: Agent }) {
  const ctx = useMain(agent);
  if (!ctx || !agent.helperSync) return null;
  const sync = agent.helperSync;
  const view = syncPresentation(sync, ctx.name);
  const merging = sync.state === "merging";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Sync status: ${view.label}`}
          className={cn(
            "inline-flex h-5 max-w-[220px] shrink-0 items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium transition-[filter] hover:brightness-125",
            TONE[view.tone],
          )}
        >
          {merging ? (
            <Spinner className="h-3 w-3 shrink-0" />
          ) : sync.state === "inSync" ? (
            <Check className="h-3 w-3 shrink-0" strokeWidth={2.75} />
          ) : sync.state === "conflict" ? (
            <AlertTriangle className="h-3 w-3 shrink-0" />
          ) : (
            <Clock className="h-3 w-3 shrink-0" />
          )}
          <span className="truncate">{view.label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          {view.label}
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">
          {sync.state === "inSync" &&
            `This helper and ${ctx.name} have each other's changes${sync.files > 0 ? ` (${sync.files} file${sync.files === 1 ? "" : "s"} merged)` : ""}.`}
          {sync.state === "pendingToMain" &&
            `The helper's changes are merged into ${ctx.name}'s files when ${ctx.name} finishes its turn.`}
          {sync.state === "pendingFromMain" && `${ctx.name}'s latest changes are being copied into this helper.`}
          {sync.state === "merging" && "Merging changes both ways…"}
          {sync.state === "conflict" && (sync.detail ?? "Both agents changed the same lines.")}
        </p>
        {sync.lastSyncAt && (
          <p className="mt-1.5 text-[11.5px] text-steel">Last synced {relativeTimeLong(sync.lastSyncAt)}</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="xs" variant="secondary" disabled={merging} onClick={() => void syncNow(agent)}>
            <RefreshCw className="!h-3 !w-3" /> Sync now
          </Button>
          {sync.state === "conflict" && (
            <Button size="xs" variant="primary" onClick={() => void askMain(agent, ctx.name)}>
              Ask {ctx.name} to merge
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Shown under a helper's header while its merge is stuck. */
export function ConflictBanner({ agent }: { agent: Agent }) {
  const ctx = useMain(agent);
  if (!ctx || agent.helperSync?.state !== "conflict") return null;
  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-warn/25 bg-warn/[0.07] px-4 py-2 text-[12px]"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warn" />
      <span className="min-w-[120px] flex-1 truncate text-fg" title={agent.helperSync.detail ?? undefined}>
        <span className="font-medium">Merge conflict</span>
        {agent.helperSync.detail && <span className="text-muted"> · {agent.helperSync.detail}</span>}
      </span>
      <Button size="xs" variant="secondary" onClick={() => void syncNow(agent)}>
        Sync now
      </Button>
      <Button size="xs" variant="primary" onClick={() => void askMain(agent, ctx.name)}>
        Ask {ctx.name} to merge
      </Button>
    </div>
  );
}

/** "N helpers" on a main agent's header; clicking toggles the tiled view. */
export function HelpersChip({ count, label }: { count: number; label?: boolean }) {
  const tile = useUi((s) => s.tileHelpers);
  return (
    <Tooltip content={tile ? "Showing helpers beside this agent. Click for a single pane" : "Tile helpers beside this agent"}>
      <button
        type="button"
        aria-pressed={tile}
        aria-label={`${count} helper${count === 1 ? "" : "s"}`}
        onClick={() => useUi.getState().setTileHelpers(!tile)}
        className={cn(
          "inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-[11.5px] font-medium transition-colors",
          tile ? "border-accent/30 bg-accent/10 text-accent" : "border-line bg-card/60 text-muted hover:text-fg",
        )}
      >
        <GitFork className="h-3 w-3" />
        {label === false ? count : `${count} helper${count === 1 ? "" : "s"}`}
      </button>
    </Tooltip>
  );
}

/** Header toggle: tile the main agent with its helpers, or show one pane. */
export function TileToggle() {
  const tile = useUi((s) => s.tileHelpers);
  return (
    <Tooltip content={tile ? "Show one pane" : "Tile helpers"}>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Tile helpers"
        aria-pressed={tile}
        onClick={() => useUi.getState().setTileHelpers(!tile)}
      >
        <Columns2 />
      </Button>
    </Tooltip>
  );
}
