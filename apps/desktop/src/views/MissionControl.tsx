import { LayoutGrid, Plus, Radar, Rows3 } from "lucide-react";
import { m, AnimatePresence } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { AgentTile } from "@/components/mission/AgentTile";
import { HeaderAction, PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { splitCost } from "@/lib/costSplit";
import { formatCost } from "@/lib/format";
import type { Agent, AgentStatus } from "@/lib/types";
import { isMac, modKey } from "@/lib/utils";

import { AgentRowCompact } from "@/components/mission/AgentRowCompact";
import { EMPTY_SUMMARY, useTileSummaries } from "@/components/mission/useTileSummaries";
import { Tooltip } from "@/components/ui/tooltip";
import { useApp, usePendingPermissions, type PendingPermission } from "@/store/app";
import { useUi } from "@/store/ui";

type Density = "comfortable" | "compact";
const DENSITY_KEY = "armada.missionDensity";

function readDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

type Filter = "all" | "live" | "needs" | "idle";

const LIVE: AgentStatus[] = ["working", "starting", "needs_permission"];
const NEEDS: AgentStatus[] = ["needs_permission", "error", "interrupted"];
const IDLE: AgentStatus[] = ["idle", "stopped"];

const ORDER: Record<AgentStatus, number> = {
  needs_permission: 0,
  working: 1,
  starting: 2,
  error: 3,
  interrupted: 4,
  idle: 5,
  stopped: 6,
};

function matches(a: Agent, f: Filter) {
  if (f === "live") return LIVE.includes(a.status);
  if (f === "needs") return NEEDS.includes(a.status) || a.pendingPermissions > 0;
  if (f === "idle") return IDLE.includes(a.status);
  return true;
}

export function MissionControlView() {
  const agentsMap = useApp((s) => s.agents);
  const pending = usePendingPermissions();
  const summaries = useTileSummaries();
  const accounts = useApp((s) => s.accounts);
  const openAgent = useUi((s) => s.openAgent);
  const openNewAgent = useUi((s) => s.openNewAgent);
  const [filter, setFilter] = useState<Filter>("all");
  const [density, setDensityState] = useState<Density>(readDensity);
  const setDensity = (d: Density) => {
    setDensityState(d);
    try {
      localStorage.setItem(DENSITY_KEY, d);
    } catch {
      /* ignore */
    }
  };

  const agents = useMemo(
    () =>
      Object.values(agentsMap)
        .filter((a) => !a.archived)
        // Stable order: status group, then creation time. (Sorting by activity made tiles jump on
        // every cost/token tick.)
        .sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.createdAt - a.createdAt),
    [agentsMap],
  );

  const pendingByAgent = useMemo(() => {
    const map = new Map<string, PendingPermission["item"]>();
    for (const p of pending) {
      if (!map.has(p.agent.id)) map.set(p.agent.id, p.item);
    }
    return map;
  }, [pending]);

  // Lazily load timelines for live agents so tiles can show their last action.
  const liveIds = agents
    .filter((a) => LIVE.includes(a.status))
    .map((a) => a.id)
    .join(",");
  useEffect(() => {
    if (!liveIds) return;
    const ensure = useApp.getState().ensureItems;
    for (const id of liveIds.split(",")) void ensure(id);
  }, [liveIds]);

  const counts = useMemo(() => {
    const c = { all: agents.length, live: 0, needs: 0, idle: 0 };
    for (const a of agents) {
      if (matches(a, "live")) c.live++;
      if (matches(a, "needs")) c.needs++;
      if (matches(a, "idle")) c.idle++;
    }
    return c;
  }, [agents]);

  const cost = splitCost(agents, accounts);
  const visible = agents.filter((a) => matches(a, filter));
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const chip = (label: string, n: number, tone?: string) => (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      {label}
      <span
        className="rounded-md bg-base/70 px-1 text-[10.5px] tabular text-steel"
        style={tone && n > 0 ? { color: tone } : undefined}
      >
        {n}
      </span>
    </span>
  );

  return (
    <div className="@container flex h-full flex-col">
      <PageHeader
        icon={<LayoutGrid />}
        title="Mission Control"
        subtitle={
          <>
            <span className="tabular">{counts.live}</span> live · <span className="tabular">{counts.needs}</span> need
            you ·{" "}
            {cost.billed > 0 && (
              <>
                <span className="tabular">{formatCost(cost.billed)}</span> billed
                {cost.equivalent > 0 && " · "}
              </>
            )}
            {cost.equivalent > 0 && (
              <>
                <span className="tabular">{formatCost(cost.equivalent)}</span> API-equivalent on subscriptions
              </>
            )}
            {cost.billed === 0 && cost.equivalent === 0 && "no usage yet"}
          </>
        }
        right={
          <>
            <Segmented<Density>
              size="sm"
              aria-label="Density"
              value={density}
              onChange={setDensity}
              options={[
                {
                  value: "comfortable",
                  ariaLabel: "Grid view",
                  label: (
                    <Tooltip content="Tiles">
                      <LayoutGrid className="h-3.5 w-3.5" aria-hidden />
                    </Tooltip>
                  ),
                },
                {
                  value: "compact",
                  ariaLabel: "List view",
                  label: (
                    <Tooltip content="Compact rows">
                      <Rows3 className="h-3.5 w-3.5" aria-hidden />
                    </Tooltip>
                  ),
                },
              ]}
            />
            <HeaderAction
              variant="primary"
              icon={<Plus />}
              label="New agent"
              hint={`${modKey}${isMac ? "" : "+"}N`}
              onClick={() => openNewAgent()}
            />
          </>
        }
      >
        <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] @2xl/ph:mx-0 @2xl/ph:px-0 [&::-webkit-scrollbar]:hidden">
          <Segmented<Filter>
            size="sm"
            aria-label="Filter agents"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: chip("All", counts.all) },
              { value: "live", label: chip("Live", counts.live, "var(--accent)") },
              { value: "needs", label: chip("Needs you", counts.needs, "var(--warn)") },
              { value: "idle", label: chip("Idle", counts.idle) },
            ]}
          />
        </div>
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 @2xl:px-6 @2xl:py-5">
        {agents.length === 0 ? (
          <EmptyState
            className="my-auto"
            icon={<Radar />}
            title="Your fleet is docked"
            description="Launch an agent and it shows up here as a live tile: status, last action and approvals at a glance."
            action={
              <Button variant="primary" onClick={() => openNewAgent()}>
                <Plus /> New agent
              </Button>
            }
          />
        ) : visible.length === 0 ? (
          <EmptyState
            className="my-auto"
            icon={<Radar />}
            title="All quiet on this channel"
            description="No agents match this filter right now."
            action={
              <Button variant="secondary" onClick={() => setFilter("all")}>
                Show all agents
              </Button>
            }
          />
        ) : density === "compact" ? (
          <div
            role="list"
            aria-label="Agents"
            className="@container overflow-hidden rounded-xl border border-line bg-card edge"
          >
            <div className="contents">
              {visible.map((a) => (
                <AgentRowCompact
                  key={a.id}
                  agent={a}
                  account={accountMap.get(a.accountId)}
                  summary={summaries.get(a.id) ?? EMPTY_SUMMARY}
                  pending={pendingByAgent.get(a.id) ?? null}
                  onOpen={openAgent}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:[grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
            <AnimatePresence initial={false}>
              {visible.map((a) => (
                // No `layout`: it measured every tile on every render. Tiles only move when an agent
                // changes status group, which is a deliberate jump, not an animation.
                <m.div
                  key={a.id}
                  className="h-full"
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{ duration: 0.16, ease: [0.2, 0.8, 0.2, 1] }}
                >
                  <AgentTile
                    agent={a}
                    account={accountMap.get(a.accountId)}
                    summary={summaries.get(a.id) ?? EMPTY_SUMMARY}
                    pending={pendingByAgent.get(a.id) ?? null}
                    onOpen={openAgent}
                  />
                </m.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}
