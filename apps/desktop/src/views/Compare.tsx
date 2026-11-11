import { Archive, Columns3, MessageSquare, Plus, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AgentGrid } from "@/components/compare/AgentGrid";
import { HeaderAction, PageHeader } from "@/components/PageHeader";
import { ProviderGlyph } from "@/components/ProviderGlyph";
import { Button } from "@/components/ui/button";
import { EmptyPane } from "@/components/ui/emptyPane";
import { api } from "@/lib/api";
import { useNow } from "@/hooks/useNow";
import { relativeTimeLong } from "@/lib/format";
import { identityFor } from "@/lib/identity";
import { providerRank } from "@/lib/providers";
import type { Agent, TimelineItem } from "@/lib/types";
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
  const compareGroupId = useUi((s) => s.compareGroupId);
  const openCompare = useUi((s) => s.openCompare);
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

  // Returns the prompt text itself, so streamed frames of the columns don't re-render this whole page.
  const prompt = useApp(
    useMemo(
      () => (s: { items: Record<string, TimelineItem[]> }) => {
        for (const id of groupIds ? groupIds.split(",") : []) {
          const first = s.items[id]?.find((i) => i.kind === "user_message");
          if (first && first.kind === "user_message") return first.text;
        }
        return null;
      },
      [groupIds],
    ),
  );

  if (!group) {
    return (
      <div className="@container flex h-full flex-col">
        <PageHeader icon={<Columns3 />} title="Compare" subtitle="One prompt, several agents, side by side" />
        <EmptyPane
          icon={<Columns3 />}
          title="No comparisons yet"
          description="Send one prompt to several agents at once, read the answers side by side and keep the best."
          actionIcon={<Plus />}
          actionLabel="New comparison"
          onAction={() => openNewAgent({ compare: true })}
        />
      </div>
    );
  }

  const active = group.agents.filter((a) => !a.archived);
  const archived = group.agents.filter((a) => a.archived);
  const columns = showArchived ? group.agents : active.length ? active : group.agents;
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
          <>
            <HeaderAction
              icon={<Plus />}
              label="Add agents"
              onClick={() => openNewAgent({ projectPath: group.agents[0].projectPath })}
            />
            <HeaderAction
              icon={<Sparkles />}
              label="New comparison"
              variant="primary"
              onClick={() => openNewAgent({ compare: true })}
            />
          </>
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
                    "flex h-8 max-w-[260px] shrink-0 items-center gap-2 rounded-lg border px-2.5 text-small transition-colors",
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
            <div className="eyebrow text-steel">Prompt</div>
            <p className="selectable mt-0.5 line-clamp-3 text-body leading-relaxed text-fg">{prompt ?? group.title}</p>
          </div>
          {archived.length > 0 && (
            <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setShowArchived((v) => !v)}>
              <Archive /> {showArchived ? "Hide" : "Show"} {archived.length} archived
            </Button>
          )}
        </div>

        <AgentGrid
          agents={columns}
          onKeep={(a) => void keep(a)}
          keepDisabled={(a) => keeping || (active.length === 1 && active[0].id === a.id)}
        />
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
