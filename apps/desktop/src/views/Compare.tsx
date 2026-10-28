import { Archive, Columns3, MessageSquare, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CompareColumn } from "@/components/compare/CompareColumn";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
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
      <div className="flex h-full flex-col">
        <PageHeader icon={<Columns3 />} title="Compare" subtitle="One prompt, several agents, side by side" />
        <div className="flex flex-1 items-center justify-center">
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
  const minCost = Math.min(...columns.map((a) => a.costUsd));

  const keep = async (winner: Agent) => {
    const losers = group.agents.filter((a) => a.id !== winner.id && !a.archived);
    setKeeping(true);
    try {
      await Promise.all(losers.map((a) => api.archiveAgent(a.id, true)));
      if (winner.archived) await api.archiveAgent(winner.id, false);
      const who = identityFor(winner.provider, winner.customAgentId, useApp.getState().settings?.customAgents);
      toast.success(`Kept ${who.short}'s answer`, {
        description: losers.length
          ? `Archived ${losers.length} other ${losers.length === 1 ? "agent" : "agents"}.`
          : undefined,
        action: losers.length
          ? {
              label: "Undo",
              onClick: () => void Promise.all(losers.map((a) => api.archiveAgent(a.id, false))),
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
    <div className="flex h-full flex-col">
      <PageHeader
        icon={<Columns3 />}
        title="Compare"
        subtitle={`${group.agents.length} agents · ${basename(group.agents[0].projectPath)} · started ${relativeTimeLong(group.createdAt, now)}`}
        right={
          <Button size="sm" variant="secondary" onClick={() => openNewAgent({ compare: true })}>
            <Sparkles /> New comparison
          </Button>
        }
      >
        {groups.length > 1 && (
          <div role="tablist" aria-label="Comparison groups" className="-mb-1 flex gap-1.5 overflow-x-auto pb-1">
            {groups.map((g) => {
              const sel = g.id === group.id;
              return (
                <button
                  key={g.id}
                  type="button"
                  role="tab"
                  aria-selected={sel}
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

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-5">
        <div className="flex shrink-0 items-start gap-3 rounded-xl border border-line bg-panel/60 px-4 py-3 edge">
          <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-steel">Prompt</div>
            <p className="selectable mt-0.5 line-clamp-3 text-[13px] leading-relaxed text-fg">
              {prompt ?? group.title}
            </p>
          </div>
          {archived.length > 0 && (
            <Button size="xs" variant="ghost" onClick={() => setShowArchived((v) => !v)}>
              <Archive /> {showArchived ? "Hide" : "Show"} {archived.length} archived
            </Button>
          )}
        </div>

        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-1">
          {columns.map((a) => (
            <div key={a.id} className={cn("flex min-h-0 min-w-[320px] flex-1 basis-0", a.archived && "opacity-55")}>
              <CompareColumn
                agent={a}
                account={accountMap.get(a.accountId)}
                items={items[a.id]}
                now={now}
                cheapest={columns.length > 1 && a.costUsd === minCost}
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
