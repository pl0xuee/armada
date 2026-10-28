import { Archive, Columns3, MessageSquare, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CompareColumn } from "@/components/compare/CompareColumn";
import { EmptyState } from "@/components/EmptyState";
import { HeaderAction, PageHeader } from "@/components/PageHeader";
import { ProviderGlyph } from "@/components/ProviderGlyph";
import { Button } from "@/components/ui/button";
import { useNow } from "@/hooks/useNow";
import { api } from "@/lib/api";
import { relativeTimeLong } from "@/lib/format";
import { identityFor } from "@/lib/identity";
import { providerRank } from "@/lib/providers";
import type { Agent } from "@/lib/types";
import { basename, cn, errorMessage } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";

interface Group {
  id: string;
  agents: Agent[];
  title: string;
  createdAt: number;
  live: boolean;
}

function buildGroups(agents: Record<string, Agent>): Group[] {
  const map = new Map<string, Agent[]>();
  for (const a of Object.values(agents)) {
    if (!a.groupId) continue;
    const list = map.get(a.groupId) ?? [];
    list.push(a);
    map.set(a.groupId, list);
  }
  const groups: Group[] = [];
  for (const [id, list] of map) {
    list.sort((x, y) => providerRank(x.provider) - providerRank(y.provider) || x.createdAt - y.createdAt);
    groups.push({
      id,
      agents: list,
      title: list[0].title,
      createdAt: Math.min(...list.map((a) => a.createdAt)),
      live: list.some((a) => a.status === "working" || a.status === "starting" || a.status === "needs_permission"),
    });
  }
  return groups.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Pane width at which columns sit side by side (each needs ~320px); below it the
 * columns become tabs. Literal class strings so Tailwind can see them.
 */
const WIDE = {
  2: { tabs: "@3xl:hidden", col: "@3xl:flex @3xl:min-w-[300px]", row: "@3xl:overflow-x-auto" },
  3: { tabs: "@5xl:hidden", col: "@5xl:flex @5xl:min-w-[300px]", row: "@5xl:overflow-x-auto" },
  4: { tabs: "@7xl:hidden", col: "@7xl:flex @7xl:min-w-[300px]", row: "@7xl:overflow-x-auto" },
} as const;

export function CompareView() {
  const agents = useApp((s) => s.agents);
  const items = useApp((s) => s.items);
  const accounts = useApp((s) => s.accounts);
  const compareGroupId = useUi((s) => s.compareGroupId);
  const openCompare = useUi((s) => s.openCompare);
  const openAgent = useUi((s) => s.openAgent);
  const openNewAgent = useUi((s) => s.openNewAgent);
  const now = useNow();
  const [keeping, setKeeping] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  /** Column shown on narrow panes, where columns become tabs. */
  const [tabId, setTabId] = useState<string | null>(null);
  const customAgents = useApp((s) => s.settings?.customAgents);

  const groups = useMemo(() => buildGroups(agents), [agents]);
  const group = groups.find((g) => g.id === compareGroupId) ?? groups[0];

  const groupIds = group?.agents.map((a) => a.id).join(",") ?? "";
  useEffect(() => {
    if (!groupIds) return;
    for (const id of groupIds.split(",")) void useApp.getState().ensureItems(id);
  }, [groupIds]);

  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const prompt = useMemo(() => {
    if (!group) return null;
    for (const a of group.agents) {
      const first = items[a.id]?.find((i) => i.kind === "user_message");
      if (first && first.kind === "user_message") return first.text;
    }
    return null;
  }, [group, items]);

  if (!group) {
    return (
      <div className="@container flex h-full flex-col">
        <PageHeader icon={<Columns3 />} title="Compare" subtitle="One prompt, several agents, side by side" />
        <div className="flex flex-1 items-center justify-center overflow-y-auto">
          <EmptyState
            icon={<Columns3 />}
            title="Run a bake-off"
            description="Send the same prompt to Claude, Codex and Grok at once (or two accounts of the same provider), then read the answers side by side and keep the best one."
            action={
              <Button variant="primary" onClick={() => openNewAgent({ compare: true })}>
                <Sparkles /> Start a comparison
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  const active = group.agents.filter((a) => !a.archived);
  const archived = group.agents.filter((a) => a.archived);
  const columns = showArchived ? group.agents : active.length ? active : group.agents;
  const costs = columns.map((a) => a.costUsd);
  const minCost = Math.min(...costs);
  // "Cheapest" only means something once every answer is in and the costs actually differ.
  const anyWorking = columns.some(
    (a) => a.status === "working" || a.status === "starting" || a.status === "needs_permission",
  );
  const showCheapest = columns.length > 1 && !anyWorking && minCost < Math.max(...costs);
  const activeTab = columns.find((a) => a.id === tabId) ?? columns[0];
  const bp = columns.length <= 2 ? WIDE[2] : columns.length === 3 ? WIDE[3] : WIDE[4];

  const keep = async (winner: Agent) => {
    const losers = group.agents.filter((a) => a.id !== winner.id && !a.archived);
    setKeeping(true);
    try {
      // Stop the others' turns first so they don't keep spending in the background.
      await Promise.all(
        losers
          .filter((a) => a.status === "working" || a.status === "starting" || a.status === "needs_permission")
          .map((a) => api.cancelTurn(a.id).catch(() => {})),
      );
      await Promise.all(losers.map((a) => api.archiveAgent(a.id, true)));
      if (winner.archived) await api.archiveAgent(winner.id, false);
      const who = identityFor(winner.provider, winner.customAgentId, useApp.getState().settings?.customAgents);
      toast.success(`Kept ${who.short}'s answer`, {
        description: losers.length
          ? `Stopped and archived ${losers.length} other ${losers.length === 1 ? "agent" : "agents"}.`
          : undefined,
        action: losers.length
          ? {
              label: "Undo",
              onClick: () =>
                void Promise.all(losers.map((a) => api.archiveAgent(a.id, false))).catch((e: unknown) =>
                  toast.error("Couldn't restore the other agents", { description: errorMessage(e) }),
                ),
            }
          : undefined,
      });
    } catch (e) {
      toast.error("Couldn't archive the other agents", { description: errorMessage(e) });
    } finally {
      setKeeping(false);
    }
  };

  return (
    <div className="@container flex h-full flex-col">
      <PageHeader
        icon={<Columns3 />}
        title="Compare"
        subtitle={`${group.agents.length} agents · ${basename(group.agents[0].projectPath)} · started ${relativeTimeLong(group.createdAt, now)}`}
        right={
          <HeaderAction icon={<Sparkles />} label="New comparison" onClick={() => openNewAgent({ compare: true })} />
        }
      >
        {groups.length > 1 && (
          <div
            role="tablist"
            aria-label="Comparison groups"
            onKeyDown={(e) =>
              tabKeys(
                e,
                groups.map((g) => g.id),
                group.id,
                (id) => openCompare(id),
                "cmp-group-",
              )
            }
            className="-mb-1 flex gap-1.5 overflow-x-auto pb-1"
          >
            {groups.map((g) => {
              const sel = g.id === group.id;
              return (
                <button
                  key={g.id}
                  id={`cmp-group-${g.id}`}
                  type="button"
                  role="tab"
                  aria-selected={sel}
                  tabIndex={sel ? 0 : -1}
                  onClick={() => openCompare(g.id)}
                  className={cn(
                    "flex h-8 max-w-[260px] shrink-0 items-center gap-2 rounded-lg border px-2.5 text-[12.5px] transition-colors",
                    sel
                      ? "border-line-strong bg-raised text-fg edge"
                      : "border-transparent text-muted hover:bg-raised/60 hover:text-fg",
                  )}
                >
                  <span className="flex -space-x-1">
                    {g.agents.slice(0, 4).map((a) => (
                      <ProviderGlyph
                        key={a.id}
                        provider={a.provider}
                        customAgentId={a.customAgentId}
                        size="xs"
                        className="ring-2 ring-panel"
                      />
                    ))}
                  </span>
                  <span className="truncate">{g.title}</span>
                  {g.live && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent animate-breathe" />}
                </button>
              );
            })}
          </div>
        )}
      </PageHeader>

      <div className="mx-auto flex min-h-0 w-full max-w-[1920px] flex-1 flex-col gap-3 px-4 py-4 @2xl:gap-4 @2xl:px-6 @2xl:py-5">
        <div className="flex shrink-0 flex-wrap items-start gap-x-3 gap-y-1.5 rounded-xl border border-line bg-panel/60 px-4 py-3 edge">
          <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-steel">Prompt</div>
            <p className="selectable mt-0.5 line-clamp-3 text-[13px] leading-relaxed text-fg">
              {prompt ?? group.title}
            </p>
          </div>
          {archived.length > 0 && (
            <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setShowArchived((v) => !v)}>
              <Archive /> {showArchived ? "Hide" : "Show"} {archived.length} archived
            </Button>
          )}
        </div>

        {columns.length > 1 && (
          <div
            role="tablist"
            aria-label="Agents in this comparison"
            onKeyDown={(e) =>
              tabKeys(
                e,
                columns.map((a) => a.id),
                activeTab.id,
                setTabId,
                "cmp-tab-",
              )
            }
            className={cn(
              "-mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              bp.tabs,
            )}
          >
            {columns.map((a) => {
              const id = identityFor(a.provider, a.customAgentId, customAgents);
              const sel = a.id === activeTab.id;
              return (
                <button
                  key={a.id}
                  id={`cmp-tab-${a.id}`}
                  type="button"
                  role="tab"
                  aria-selected={sel}
                  tabIndex={sel ? 0 : -1}
                  aria-controls={`cmp-col-${a.id}`}
                  onClick={() => setTabId(a.id)}
                  className={cn(
                    "flex h-9 min-w-0 flex-1 basis-0 items-center justify-center gap-2 rounded-lg border px-3 text-[12.5px] font-medium transition-colors",
                    sel
                      ? "border-line-strong bg-raised text-fg edge"
                      : "border-line/60 text-muted hover:bg-raised/60 hover:text-fg",
                    a.archived && "opacity-60",
                  )}
                >
                  <ProviderGlyph provider={a.provider} customAgentId={a.customAgentId} size="xs" />
                  <span className="truncate">{id.short}</span>
                  {a.status === "working" || a.status === "starting" ? (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent animate-breathe"
                      aria-label="Working"
                    />
                  ) : showCheapest && a.costUsd === minCost ? (
                    <span className="hidden text-[10.5px] font-normal text-ok @md:inline">cheapest</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}

        <div className={cn("flex min-h-0 flex-1 gap-3 pb-1", bp.row)}>
          {columns.map((a) => (
            <div
              key={a.id}
              id={`cmp-col-${a.id}`}
              role="tabpanel"
              aria-labelledby={columns.length > 1 ? `cmp-tab-${a.id}` : undefined}
              className={cn(
                "min-h-0 min-w-0 flex-1 basis-0",
                bp.col,
                a.id === activeTab.id ? "flex" : "hidden",
                a.archived && "opacity-55",
              )}
            >
              <CompareColumn
                agent={a}
                account={accountMap.get(a.accountId)}
                items={items[a.id]}
                now={now}
                cheapest={showCheapest && a.costUsd === minCost}
                onOpen={() => openAgent(a.id)}
                onKeep={() => void keep(a)}
                keeping={keeping || (active.length === 1 && active[0].id === a.id)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** WAI-ARIA tabs: ←/→ (wrapping), Home/End move the selection and focus. */
function tabKeys(
  e: React.KeyboardEvent<HTMLElement>,
  ids: string[],
  current: string,
  select: (id: string) => void,
  idPrefix: string,
) {
  const i = ids.indexOf(current);
  let next = -1;
  if (e.key === "ArrowRight") next = (i + 1) % ids.length;
  else if (e.key === "ArrowLeft") next = (i - 1 + ids.length) % ids.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = ids.length - 1;
  if (next < 0 || ids.length === 0) return;
  e.preventDefault();
  select(ids[next]);
  requestAnimationFrame(() => document.getElementById(`${idPrefix}${ids[next]}`)?.focus());
}
