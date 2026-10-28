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
import { basename, plainPreview, plural, relativeTime, relativeTimeLong } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { agentIdentity, safeColor, statusMeta } from "@/lib/meta";
import { navigate } from "@/lib/router";
import { accountOf, filterAgents, groupFleet, useAgentPending, useInbox } from "@/lib/selectors";
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
  const inbox = useInbox();
  const now = useNow();
  const [showArchived, setShowArchived] = useState(false);
  const [settings, setSettings] = useState(devParam("sheet") === "settings");
  const owner = useStore((s) => s.session?.scope === "owner");

  const list = useMemo(() => Object.values(agents), [agents]);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterAgents(list, query), [list, query]);
  const groups = useMemo(() => groupFleet(filtered), [filtered]);
  const working = groups.find((g) => g.id === "working")?.agents.length ?? 0;
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
  } else if (active === 0 && groups[3].agents.length === 0) {
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
        {!query && inbox.count > 0 && <InboxCallout count={inbox.count} />}
        {groups.map((g) => {
          if (!g.agents.length) return null;
          const archived = g.id === "archived";
          const open = !archived || showArchived;
          return (
            <section key={g.id} aria-labelledby={`group-${g.id}`}>
              <h2 id={`group-${g.id}`} className="mb-2 flex items-center px-1">
                {archived ? (
                  <button
                    type="button"
                    onClick={() => setShowArchived((v) => !v)}
                    aria-expanded={showArchived}
                    className="press -mx-1 flex h-9 items-center gap-1.5 rounded-lg px-1 text-[12px] font-semibold tracking-[0.08em] text-steel uppercase"
                  >
                    {g.label}
                    <span className="tabular">{g.agents.length}</span>
                    <Icon name="chevronDown" size={15} className={cn("transition-transform duration-150", !showArchived && "-rotate-90")} />
                  </button>
                ) : (
                  <span
                    className={cn(
                      "flex h-9 items-center gap-1.5 text-[12px] font-semibold tracking-[0.08em] uppercase",
                      g.id === "needs" ? "text-warn" : "text-steel",
                    )}
                  >
                    {g.label}
                    <span className="tabular opacity-80">{g.agents.length}</span>
                  </span>
                )}
              </h2>
              {open && (
                <ul className="overflow-hidden rounded-2xl border border-line bg-panel edge">
                  {g.agents.map((a, i) => (
                    <li key={a.id} className={cn(i > 0 && "border-t border-line/70")}>
                      <AgentRow agent={a} now={now} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
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
            <IconButton icon="inbox" label="Inbox" badge={inbox.count} tone="warn" onClick={() => navigate({ name: "inbox" })} />
            <IconButton icon="sliders" label="Settings" onClick={() => setSettings(true)} />
          </div>
        }
      />
      <main className="mx-auto w-full max-w-[860px] flex-1 px-safe pt-4 pb-[calc(96px+var(--safe-bottom))]">{body}</main>
      {owner && stateStatus === "ready" && (
        <button
          type="button"
          onClick={() => navigate({ name: "new" })}
          className="press animate-enter fixed right-[max(16px,var(--safe-right))] bottom-[max(18px,calc(var(--safe-bottom)+10px))] z-30 inline-flex h-14 items-center gap-2 rounded-full bg-accent pr-5 pl-4 text-[15.5px] font-semibold text-accent-fg shadow-[0_14px_34px_-10px_color-mix(in_srgb,var(--accent)_75%,transparent),inset_0_1px_0_rgba(255,255,255,0.35)]"
        >
          <Icon name="plus" size={22} strokeWidth={2.4} />
          New agent
        </button>
      )}
      <SettingsSheet open={settings} onClose={() => setSettings(false)} />
    </div>
  );
}

function InboxCallout({ count }: { count: number }) {
  return (
    <button
      type="button"
      onClick={() => navigate({ name: "inbox" })}
      className="press animate-enter flex w-full items-center gap-3 rounded-2xl border border-warn/40 bg-warn/[0.08] p-3 pr-2 text-left shadow-[0_12px_32px_-18px_color-mix(in_srgb,var(--warn)_60%,transparent)]"
    >
      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warn text-warn-fg">
        <Icon name="shield" size={20} strokeWidth={2} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-fg">
          {count === 1 ? "1 approval waiting" : `${count} approvals waiting`}
        </span>
        <span className="block truncate text-[13px] text-muted">Agents are paused until you respond</span>
      </span>
      <span className="inline-flex h-11 shrink-0 items-center gap-0.5 pr-1 pl-2 text-[14px] font-semibold text-warn">
        <span className="max-[359px]:sr-only">Review</span>
        <Icon name="chevronRight" size={18} />
      </span>
    </button>
  );
}

const AgentRow = memo(function AgentRow({ agent, now }: { agent: Agent; now: number }) {
  const account = useStore((s) => accountOf(s.accounts, agent));
  const customAgents = useStore((s) => s.customAgents);
  const pending = useAgentPending(agent);
  const id = agentIdentity(agent, customAgents);
  const preview = agent.lastMessage ? plainPreview(agent.lastMessage) : null;
  const needs = agent.status === "needs_permission" || pending > 0;

  return (
    <button
      type="button"
      onClick={() => navigate({ name: "agent", agentId: agent.id })}
      aria-label={`${agent.title}, ${statusMeta(agent.status).label}${pending ? `, ${pending} waiting for approval` : ""}`}
      className={cn("press-row relative flex w-full items-start gap-3 px-3.5 py-3 text-left", needs && "bg-warn/[0.035]")}
    >
      {needs && <span className="absolute inset-y-3 left-0 w-[3px] rounded-r-full bg-warn" aria-hidden />}
      <ProviderBadge agent={agent} size={42} status={agent.status} className="mt-0.5" />
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
          <StatusText status={agent.status} className="shrink-0" />
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
          {agent.projectPath && (
            <>
              <span className="text-line-strong" aria-hidden>
                ·
              </span>
              <span className="min-w-0 truncate text-steel">{basename(agent.projectPath)}</span>
            </>
          )}
        </span>
        {(preview || pending > 0) && (
          <span className="mt-1 flex items-start gap-2">
            <span className="line-clamp-2 min-w-0 flex-1 text-[13.5px] leading-[1.4] text-muted">
              {preview ?? (pending > 0 ? "Waiting for your approval" : "")}
            </span>
            {pending > 0 && (
              <span className="mt-px inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full bg-warn px-2 text-[12px] font-bold text-warn-fg tabular">
                <Icon name="shield" size={12} strokeWidth={2.4} />
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
