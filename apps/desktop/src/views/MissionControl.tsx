import { LayoutGrid, Plus, Rows3 } from "lucide-react";
import { useEffect, useState } from "react";
import { AllAgentsPane, type Density } from "@/components/mission/AllAgents";
import { NeedsYouPane } from "@/components/mission/NeedsYou";
import { useFleet, type Filter } from "@/components/mission/useFleet";
import { HeaderAction, PageHeader } from "@/components/PageHeader";
import { useTriageCount } from "@/components/triage/useTriage";
import { Segmented } from "@/components/ui/segmented";
import { Tooltip } from "@/components/ui/tooltip";
import { splitCost } from "@/lib/costSplit";
import { formatCost } from "@/lib/format";
import { isMac, modKey } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUi, type MissionTab } from "@/store/ui";

const DENSITY_KEY = "armada.missionDensity";

function readDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

/** A tab or filter label with its count; `tone` colours the count while it is above zero. */
function chip(label: string, n: number, tone?: string) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      {label}
      <span
        className="rounded-md bg-base/70 px-1 text-micro tabular text-steel"
        style={tone && n > 0 ? { color: tone } : undefined}
      >
        {n}
      </span>
    </span>
  );
}

/**
 * One place for the fleet: "Needs you" is the queue (answer, approve, resume from here), "All agents"
 * is the live board. Both count agents the same way, so the rail badge, the tab and the title agree.
 */
export function MissionControlView() {
  const needs = useTriageCount();
  const { agents, live, idle } = useFleet();
  const accounts = useApp((s) => s.accounts);
  const openMission = useUi((s) => s.openMission);
  const openNewAgent = useUi((s) => s.openNewAgent);
  // Chosen once when the view opens (Needs you if anything waits), so the tab doesn't jump under you
  // when an agent starts or stops needing you.
  const [opened] = useState<MissionTab>(() => (needs > 0 ? "needs" : "all"));
  const chosen = useUi((s) => s.missionTab);
  const tab = chosen ?? opened;
  useEffect(() => {
    // Record the pick so the shortcuts know which tab is showing.
    if (chosen === null) openMission(opened);
  }, [chosen, opened, openMission]);
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

  const cost = splitCost(agents, accounts);

  return (
    <div className="@container flex h-full flex-col">
      <PageHeader
        icon={<LayoutGrid />}
        title="Mission Control"
        subtitle={
          <>
            <span className="tabular">{needs}</span> need{needs === 1 ? "s" : ""} you ·{" "}
            <span className="tabular">{live}</span> live ·{" "}
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
            {tab === "all" && agents.length > 0 && (
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
            )}
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
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <Segmented<MissionTab>
            size="sm"
            aria-label="Mission Control"
            value={tab}
            onChange={openMission}
            options={[
              { value: "needs", label: chip("Needs you", needs, "var(--warn)") },
              { value: "all", label: chip("All agents", agents.length) },
            ]}
          />
          {tab === "all" && agents.length > 0 && (
            <Segmented<Filter>
              size="sm"
              aria-label="Filter agents"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "live", label: chip("Live", live, "var(--accent)") },
                { value: "idle", label: chip("Idle", idle) },
              ]}
            />
          )}
        </div>
      </PageHeader>

      {tab === "needs" ? (
        <div className="min-h-0 flex-1">
          <NeedsYouPane hasAgents={agents.length > 0} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 @2xl:px-6 @2xl:py-5">
          <AllAgentsPane agents={agents} filter={filter} density={density} onClearFilter={() => setFilter("all")} />
        </div>
      )}
    </div>
  );
}
