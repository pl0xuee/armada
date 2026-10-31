import { FolderOpen, MessageSquare, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Composer } from "@/components/agent/Composer";
import { AgentGrid, agentNumbers } from "@/components/compare/AgentGrid";
import { HomeComposer } from "@/components/home/HomeComposer";
import { PageHeader } from "@/components/PageHeader";
import { Segmented } from "@/components/ui/segmented";
import { groupByProject, projectKey } from "@/lib/agents";
import { nestHelpers } from "@/lib/helpers";
import { identityFor } from "@/lib/identity";
import { basename, prettyPath } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";

/**
 * A project's page in the Projects tab: all its agents together in a grid that fits the window,
 * and a composer underneath that starts more of them (1 to 8 at a time) in this same project.
 */
export function ProjectView({ path }: { path: string }) {
  const agentsMap = useApp((s) => s.agents);
  const key = projectKey(path);
  const project = useMemo(() => {
    const mine = Object.values(agentsMap).filter((a) => projectKey(a.projectPath) === key);
    const group = groupByProject(mine).projects[0];
    // Helpers belong to their main agent's conversation, not a card of their own.
    const roots = group ? nestHelpers(group.agents).roots : [];
    // Oldest first, so cards keep their place (#1, #2…) as agents start and finish.
    return { agents: [...roots].sort((x, y) => x.createdAt - y.createdAt), group };
  }, [agentsMap, key]);

  const { agents, group } = project;
  const customAgents = useApp((s) => s.settings?.customAgents);
  // The card whose box is open below: the one you came back from, or the one you clicked.
  const focusId = useUi((s) => s.projectFocusId);
  const [selectedId, setSelectedId] = useState<string | null>(focusId);
  useEffect(() => setSelectedId(focusId), [focusId, key]);
  const selected = agents.find((a) => a.id === selectedId) ?? null;
  const numbers = useMemo(() => agentNumbers(agents), [agents]);
  const nameOf = (a: typeof selected) =>
    a
      ? `${identityFor(a.provider, a.customAgentId, customAgents).short}${numbers.get(a.id) ? ` ${numbers.get(a.id)}` : ""}`
      : "";
  const sub = group
    ? [
        `${agents.length} ${agents.length === 1 ? "agent" : "agents"}`,
        group.working > 0 ? `${group.working} working` : null,
        group.needs > 0 ? `${group.needs} need you` : null,
        prettyPath(key),
      ]
        .filter(Boolean)
        .join(" · ")
    : prettyPath(key);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <PageHeader icon={<FolderOpen />} title={basename(key)} subtitle={sub} />
      <div className="mx-auto flex min-h-0 w-full max-w-[1920px] flex-1 flex-col gap-3 px-4 pb-3 pt-4 @2xl:px-6">
        {agents.length > 0 ? (
          <AgentGrid agents={agents} selectedId={selectedId} onSelect={(a) => setSelectedId(a.id)} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-[13px] text-steel">
            No agents in {basename(key)} yet. Start one below.
          </div>
        )}
        <div className="mx-auto w-full max-w-[900px] shrink-0 space-y-2">
          <div className="flex items-center gap-3">
            <Segmented
              size="sm"
              aria-label="What the box below does"
              value={selected ? "message" : "spawn"}
              onChange={(v) => v === "spawn" && setSelectedId(null)}
              options={[
                {
                  value: "spawn",
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <Plus className="h-3 w-3" /> New agents
                    </span>
                  ),
                },
                {
                  value: "message",
                  disabled: !selected,
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <MessageSquare className="h-3 w-3" /> {selected ? `Tell ${nameOf(selected)}` : "Tell an agent"}
                    </span>
                  ),
                },
              ]}
            />
            {!selected && agents.length > 0 && (
              <span className="text-[11.5px] text-steel">Click an agent above to tell it something.</span>
            )}
          </div>
          {selected ? (
            <Composer key={selected.id} agent={selected} focused />
          ) : (
            <HomeComposer
              key={key}
              compact
              autoFocus={false}
              folder={key}
              placeholder={`What should more agents do in ${basename(key)}?`}
              onLaunched={() => {}}
            />
          )}
        </div>
      </div>
    </div>
  );
}
