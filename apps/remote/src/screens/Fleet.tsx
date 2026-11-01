import { memo, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { AccountDot, ProviderBadge, StatusText } from "@/components/Identity";
import { AppMark, Icon } from "@/components/Icon";
import { Sheet } from "@/components/Sheet";
import { ConnectionPill, TopBar } from "@/components/TopBar";
import { Button, IconButton } from "@/components/ui";
import { cn } from "@/lib/cn";
import { retryState, stopAgent, unpair } from "@/lib/controller";
import { confirmAction } from "@/lib/confirm";
import { devParam } from "@/lib/dev";
import { plainPreview, plural, relativeTime, relativeTimeLong } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { agentIdentity, safeColor, statusMeta } from "@/lib/meta";
import { navigate } from "@/lib/router";
import { accountOf, filterAgents, isUsageLimited, pendingKindOf, permissionIndex, USAGE_LIMIT_LABEL, useAgentPending, useTriage } from "@/lib/selectors";
import { storage } from "@/lib/storage";
import { groupByProject, needsYouLabel, projectSummary, type NeedsReason, type ProjectGroup, type TriageEntry } from "@/lib/triage";
import { useStore } from "@/lib/store";
import type { Agent } from "@/lib/types";
import { InstallTip, installTipApplies } from "@/components/InstallTip";
import { EmptyState, ErrorState } from "./States";

/** Fleet scroll position, restored when coming back from an agent. */
let savedScroll = 0;

export function Fleet() {
  const agents = useStore((s) => s.agents);
  const stateStatus = useStore((s) => s.stateStatus);
  const stateError = useStore((s) => s.stateError);
  const triage = useTriage();
  const now = useNow();
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggleProject = (path: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (!next.delete(path)) next.add(path);
      storage.set(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  const [showArchived, setShowArchived] = useState(false);
  const [settings, setSettings] = useState(devParam("sheet") === "settings");
  const owner = useStore((s) => s.session?.scope === "owner");
  const offline = useStore((s) => s.connection === "offline");

  const list = useMemo(() => Object.values(agents), [agents]);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterAgents(list, query), [list, query]);
  const { projects, archived } = useMemo(() => groupByProject(filtered, "", (a) => triage.reasons.get(a.id) ?? null), [filtered, triage.reasons]);
  const working = useMemo(() => list.filter((a) => !a.archived && (a.status === "working" || a.status === "starting")).length, [list]);
  const active = list.filter((a) => !a.archived).length;

  useLayoutEffect(() => {
    window.scrollTo({ top: savedScroll, behavior: "instant" });
    return () => {
      savedScroll = window.scrollY;
    };
  }, []);

  let body;
  if (stateStatus !== "ready" && list.length === 0) {
    body =
      stateStatus === "error" ? (
        <ErrorState title="Couldn't load your agents" body={stateError} onRetry={retryState} />
      ) : (
        <FleetSkeleton />
      );
  } else if (active === 0 && archived.length === 0) {
    body = (
      <EmptyState
        icon="sparkle"
        tone="accent"
        title="No agents yet"
        body="Start one from here with New agent, or in Armada on your computer."
      />
    );
  } else {
    body = (
      <div className="space-y-6">
        {owner && <InstallTip />}
        {list.length > 5 && (
          <div className="relative">
            <Icon name="search" size={17} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-steel" />
            <label htmlFor="fleet-search" className="sr-only">
              Search agents
            </label>
            <input
              id="fleet-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search agents"
              autoComplete="off"
              className="block h-11 w-full rounded-xl border border-line bg-panel pr-3 pl-10 text-[16px] text-fg outline-none placeholder:text-steel focus:border-accent/60"
            />
          </div>
        )}
        {query && !filtered.length && <p className="px-1 text-[14px] text-muted">No agents match "{query}".</p>}
        {!query && triage.count > 0 && <NeedsYouCallout queue={triage.queue} />}
        {projects.map((p) => (
          <ProjectSection
            key={p.path || "none"}
            project={p}
            reasons={triage.reasons}
            open={!collapsed.has(p.path) || !!query}
            onToggle={() => toggleProject(p.path)}
            now={now}
          />
        ))}
        {archived.length > 0 && (
          <section aria-labelledby="group-archived">
            <h2 id="group-archived" className="mb-2 flex items-center px-1">
              <button
                type="button"
                onClick={() => setShowArchived((v) => !v)}
                aria-expanded={showArchived}
                className="press -mx-1 flex h-11 items-center gap-1.5 rounded-lg px-1 text-[12px] font-semibold tracking-[0.08em] text-steel uppercase"
              >
                Archived
                <span className="tabular">{archived.length}</span>
                <Icon name="chevronDown" size={15} className={cn("transition-transform duration-150", !showArchived && "-rotate-90")} />
              </button>
            </h2>
            {showArchived && (
              <ul className="overflow-hidden rounded-2xl border border-line bg-panel edge">
                {archived.map((a, i) => (
                  <li key={a.id} className={cn(i > 0 && "border-t border-line/70")}>
                    <AgentRow agent={a} now={now} reason={null} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar
        left={
          <div className="flex min-w-0 items-center gap-2.5 pl-2.5">
            <AppMark size={24} />
            <div className="min-w-0">
              <h1 className="text-[17px] leading-tight font-semibold tracking-[-0.01em] text-fg">Armada</h1>
              {stateStatus === "ready" && (
                <p className="truncate text-[12px] leading-tight text-muted">
                  {plural(active, "agent")}
                  {working > 0 && ` · ${working} working`}
                </p>
              )}
            </div>
          </div>
        }
        right={
          <div className="flex items-center gap-0.5">
            <ConnectionPill className="mr-1.5" />
            <IconButton icon="inbox" label="Needs you" badge={triage.count} tone="warn" onClick={() => navigate({ name: "inbox" })} />
            <IconButton icon="sliders" label="Settings" onClick={() => setSettings(true)} />
          </div>
        }
      />
      <main className="mx-auto w-full max-w-[860px] flex-1 px-safe pt-4 pb-[calc(96px+var(--safe-bottom))]">{body}</main>
      {owner && stateStatus === "ready" && (
        <div className="pointer-events-none fixed right-[max(16px,var(--safe-right))] bottom-[max(18px,calc(var(--safe-bottom)+10px))] z-30 flex flex-col items-end gap-2">
          {offline && (
            <p role="status" className="animate-fade rounded-full border border-line-strong bg-card px-3 py-1 text-[12.5px] text-muted edge">
              Offline. Reconnect to start an agent.
            </p>
          )}
          <button
            type="button"
            disabled={offline}
            onClick={() => navigate({ name: "new" })}
            className={cn(
              "press pointer-events-auto inline-flex h-14 items-center gap-2 rounded-full pr-5 pl-4 text-[15.5px] font-semibold",
              offline
                ? "border border-line-strong bg-raised text-steel"
                : "animate-enter bg-accent text-accent-fg shadow-[0_14px_34px_-10px_color-mix(in_srgb,var(--accent)_75%,transparent),inset_0_1px_0_rgba(255,255,255,0.35)]",
            )}
          >
            <Icon name="plus" size={22} strokeWidth={2.4} />
            New agent
          </button>
        </div>
      )}
      <SettingsSheet open={settings} onClose={() => setSettings(false)} />
    </div>
  );
}

const COLLAPSED_KEY = "armada.fleet.collapsed";

function loadCollapsed(): Set<string> {
  try {
    const raw: unknown = JSON.parse(storage.get(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** "2 blocked · 1 to review": what the queue holds, in the words of its sections. */
function queueSummary(queue: readonly TriageEntry[]): string {
  const review = queue.filter((e) => e.reason === "done").length;
  const blocked = queue.length - review;
  return [blocked ? `${blocked} blocked` : null, review ? `${review} to review` : null].filter(Boolean).join(" · ");
}

function NeedsYouCallout({ queue }: { queue: readonly TriageEntry[] }) {
  const blocked = queue.some((e) => e.reason !== "done");
  return (
    <button
      type="button"
      onClick={() => navigate({ name: "inbox" })}
      className={cn(
        "press animate-enter flex w-full items-center gap-3 rounded-2xl border p-3 pr-2 text-left",
        blocked ? "border-warn/40 bg-warn/[0.08]" : "border-ok/30 bg-ok/[0.06]",
      )}
    >
      <span className={cn("inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", blocked ? "bg-warn text-warn-fg" : "bg-ok/90 text-base")}>
        <Icon name={blocked ? "shield" : "check"} size={20} strokeWidth={2} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-fg">{needsYouLabel(queue.length)}</span>
        <span className="block truncate text-[13px] text-muted">{queueSummary(queue)}</span>
      </span>
      <span className={cn("inline-flex h-11 shrink-0 items-center gap-0.5 pr-1 pl-2 text-[14px] font-semibold", blocked ? "text-warn" : "text-ok")}>
        <span className="max-[359px]:sr-only">Open</span>
        <Icon name="chevronRight" size={18} />
      </span>
    </button>
  );
}

/** One project: a header (name, counts, "N need you") that folds its agents. */
const ProjectSection = memo(function ProjectSection({
  project,
  reasons,
  open,
  onToggle,
  now,
}: {
  project: ProjectGroup;
  reasons: ReadonlyMap<string, NeedsReason>;
  open: boolean;
  onToggle: () => void;
  now: number;
}) {
  const id = `project-${project.path || "none"}`;
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="mb-1.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="press-row -mx-1 flex min-h-12 w-[calc(100%+0.5rem)] items-center gap-2 rounded-xl px-1 text-left"
        >
          <Icon name="chevronDown" size={16} className={cn("shrink-0 text-steel transition-transform duration-150", !open && "-rotate-90")} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15.5px] leading-tight font-semibold text-fg">{project.name}</span>
            <span className="block truncate text-[12.5px] leading-tight text-steel">{projectSummary(project)}</span>
          </span>
          {project.needs > 0 && (
            <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-warn/14 px-2.5 text-[12px] font-semibold text-warn tabular">
              <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden />
              {project.needs} {project.needs === 1 ? "needs" : "need"} you
            </span>
          )}
        </button>
      </h2>
      {open && (
        <ul className="overflow-hidden rounded-2xl border border-line bg-panel edge">
          {project.agents.map((a, i) => (
            <li key={a.id} className={cn(i > 0 && "border-t border-line/70")}>
              <AgentRow agent={a} now={now} reason={reasons.get(a.id) ?? null} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
});

const AgentRow = memo(function AgentRow({ agent, now, reason }: { agent: Agent; now: number; reason: string | null }) {
  const account = useStore((s) => accountOf(s.accounts, agent));
  const customAgents = useStore((s) => s.customAgents);
  const pending = useAgentPending(agent);
  // Only the kind of what's waiting (a string, so streamed updates don't re-render the row).
  const pendingKind = useStore((s) => pendingKindOf(permissionIndex(s.permissions).get(agent.id)));
  const id = agentIdentity(agent, customAgents);
  const preview = agent.lastMessage ? plainPreview(agent.lastMessage) : null;
  const limited = isUsageLimited(agent);
  // One definition of "needs you" (lib/triage), the same as the badge and the queue.
  const needs = reason !== null && reason !== "done";
  const pendingIcon = pendingKind === "question" ? "sparkle" : "shield";

  return (
    <button
      type="button"
      onClick={() => navigate({ name: "agent", agentId: agent.id })}
      aria-label={`${agent.title}, ${limited ? USAGE_LIMIT_LABEL : statusMeta(agent.status).label}${pending ? `, ${pending} waiting for approval` : ""}`}
      className={cn("press-row relative flex w-full items-start gap-3 px-3.5 py-3 text-left", needs && "bg-warn/[0.035]")}
    >
      {needs && <span className="absolute inset-y-3 left-0 w-[3px] rounded-r-full bg-warn" aria-hidden />}
      <ProviderBadge agent={agent} size={42} status={limited ? "needs_permission" : agent.status} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-[15.5px] leading-snug", agent.unread ? "font-semibold text-fg" : "font-medium text-fg/95")}>
            {agent.title}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-steel tabular" title={relativeTimeLong(agent.lastActivityAt, now)}>
            {agent.unread && <span className="h-2 w-2 rounded-full bg-accent" aria-label="Unread" />}
            {relativeTime(agent.lastActivityAt, now)}
          </span>
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px] leading-snug">
          {limited ? (
            <span className="shrink-0 font-medium text-warn">{USAGE_LIMIT_LABEL}</span>
          ) : (
            <StatusText status={agent.status} className="shrink-0" />
          )}
          <span className="text-line-strong" aria-hidden>
            ·
          </span>
          {account ? (
            <span className="flex max-w-[50%] min-w-0 shrink-0 items-center gap-1.5 text-muted">
              <AccountDot color={safeColor(account.color)} size={7} />
              <span className="truncate">{account.name}</span>
            </span>
          ) : (
            <span className="max-w-[50%] shrink-0 truncate text-muted">{id.short}</span>
          )}
        </span>
        {(preview || pending > 0) && (
          <span className="mt-1 flex items-start gap-2">
            <span className="line-clamp-2 min-w-0 flex-1 text-[13.5px] leading-[1.4] text-muted">
              {preview ?? (pending > 0 ? "Waiting for you" : "")}
            </span>
            {pending > 0 && (
              <span className="mt-px inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full bg-warn px-2 text-[12px] font-bold text-warn-fg tabular">
                <Icon name={pendingIcon} size={12} strokeWidth={2.4} />
                {pending}
              </span>
            )}
          </span>
        )}
      </span>
    </button>
  );
});

function FleetSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading agents">
      {[3, 4].map((n, g) => (
        <div key={g}>
          <div className="skeleton mb-3 ml-1 h-3 w-24" />
          <div className="overflow-hidden rounded-2xl border border-line bg-panel">
            {Array.from({ length: n }, (_, i) => (
              <div key={i} className={cn("flex gap-3 px-3.5 py-3.5", i > 0 && "border-t border-line/70")}>
                <div className="skeleton h-[42px] w-[42px] shrink-0 rounded-xl" />
                <div className="flex-1 space-y-2 pt-0.5">
                  <div className="flex justify-between gap-6">
                    <div className="skeleton h-4 w-[55%]" />
                    <div className="skeleton h-3 w-8" />
                  </div>
                  <div className="skeleton h-3 w-[40%]" />
                  <div className="skeleton h-3 w-[85%]" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function StopAll({ onDone }: { onDone: () => void }) {
  const agents = useStore((s) => s.agents);
  const running = useMemo(() => Object.values(agents).filter((a) => a.running && !a.archived && a.status !== "stopped"), [agents]);
  if (!running.length) return null;
  return (
    <Button
      variant="secondary"
      size="lg"
      icon="power"
      className="mt-4 w-full"
      onClick={async () => {
        const ok = await confirmAction({
          title: `Stop ${plural(running.length, "agent")}?`,
          body: "This ends every running agent's process. Conversations are kept and can be resumed.",
          confirmLabel: "Stop all",
          destructive: true,
        });
        if (!ok) return;
        onDone();
        await Promise.all(running.map((a) => stopAgent(a.id)));
      }}
    >
      Stop all running agents ({running.length})
    </Button>
  );
}

function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const session = useStore((s) => s.session);
  const [confirm, setConfirm] = useState(false);
  return (
    <Sheet
      open={open}
      onClose={() => {
        setConfirm(false);
        onClose();
      }}
      title="This device"
      description="Armada Remote"
    >
      <dl className="divide-y divide-line/70">
        <Row label="Connected to">
          <span className="font-mono text-[13px]">{location.host}</span>
        </Row>
        <Row label="Status">
          <ConnectionPill />
        </Row>
        <Row label="Access">{session?.scope === "owner" ? "Full control" : "Read-only"}</Row>
        {session?.version && <Row label="Armada version">{session.version}</Row>}
      </dl>
      {installTipApplies() && (
        <div className="mt-4">
          <InstallTip dismissible={false} />
        </div>
      )}
      {session?.scope === "owner" && <StopAll onDone={onClose} />}
      <p className="mt-4 text-[13px] leading-relaxed text-muted">
        Anyone with this device can approve requests and send prompts. You can revoke access from Settings → Remote on your
        computer.
      </p>
      {confirm ? (
        <div className="mt-4 rounded-2xl border border-err/30 bg-err/[0.06] p-3">
          <p className="text-[14px] text-fg">Unpair this device? You'll need to scan the QR code again to reconnect.</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button variant="danger" icon="unlink" onClick={unpair}>
              Unpair
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="danger" size="lg" icon="unlink" className="mt-4 w-full" onClick={() => setConfirm(true)}>
          Unpair this device
        </Button>
      )}
    </Sheet>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 py-2">
      <dt className="text-[14px] text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-[14px] text-fg">{children}</dd>
    </div>
  );
}
