import { Plus, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useIdentity } from "@/hooks/useIdentity";
import { tileIdsFor, MAX_TILES } from "@/lib/helpers";
import { choiceKey, launchAgents, type ResolvedLaunch } from "@/lib/launchDefaults";
import type { Agent } from "@/lib/types";
import { basename, cn, errorMessage, isMac, modKey, prettyPath } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { AgentCount } from "../home/AgentCount";
import { usePermissionMode } from "../home/PermissionModeChip";
import { useIsGitRepo } from "../home/PreflightNotes";
import { Button } from "../ui/button";
import { Textarea } from "../ui/input";
import { Spinner } from "../ui/misc";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Tooltip } from "../ui/tooltip";

/**
 * Header button that starts more agents next to this one: same agent and account, same project
 * folder, each in its own worktree. They join the agents shown together on the page.
 */
export function AddAgents({ agent, showLabel }: { agent: Agent; showLabel: boolean }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [wanted, setWanted] = useState(1);
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const [permissionMode] = usePermissionMode();
  const identity = useIdentity(agent.provider, agent.customAgentId);
  const account = useApp((s) => s.accounts.find((a) => a.id === agent.accountId));
  const tileGroup = useUi((s) => s.tileGroup);
  const tileHelpers = useUi((s) => s.tileHelpers);
  // Joined so a stream of unrelated agent updates doesn't re-render the header.
  const shownKey = useApp((s) => tileIdsFor(s.agents, agent.id, tileGroup, tileHelpers).join(","));
  const shown = shownKey ? shownKey.split(",") : [agent.id];
  const room = Math.max(0, MAX_TILES - shown.length);
  const count = Math.max(1, Math.min(wanted, room));
  const isGit = useIsGitRepo(agent.projectPath, open);
  const project = basename(agent.projectPath);
  const via = agent.provider === "custom" ? identity.name : `${identity.name} · ${account?.name ?? "this account"}`;

  const start = async () => {
    if (busy || room === 0) return;
    const target: ResolvedLaunch = {
      choice: choiceKey(agent.provider, agent.customAgentId),
      provider: agent.provider,
      accountId: agent.accountId,
      customAgentId: agent.customAgentId,
      folder: agent.projectPath,
      worktree: true,
    };
    setBusy(true);
    setFailures([]);
    try {
      const { created, failed } = await launchAgents(target, prompt, permissionMode, count);
      for (const a of created) useApp.getState().upsertAgent(a);
      const ui = useUi.getState();
      // Everything already on screen stays and the new agents join it, with the focus where it is now.
      // Not if you've moved on while they started: that would pull you back.
      if (created.length > 0 && ui.view === "agents" && ui.selectedAgentId && shown.includes(ui.selectedAgentId)) {
        ui.openAgents([...shown, ...created.map((a) => a.id)], ui.selectedAgentId);
      }
      if (failed.length === 0) {
        setOpen(false);
        setPrompt("");
        setWanted(1);
        toast.success(created.length === 1 ? "Agent added" : `Added ${created.length} agents`, {
          description: "Each has its own worktree.",
        });
      } else {
        // Only offer the ones that didn't start, so a retry can't duplicate the rest.
        const lines = [...new Set(failed)];
        setFailures(lines);
        setWanted(failed.length);
        toast.error(created.length > 0 ? `Added ${created.length}, ${failed.length} failed` : "Couldn't add agents", {
          description: lines.join("\n"),
        });
      }
    } catch (e) {
      setFailures([errorMessage(e)]);
    } finally {
      setBusy(false);
    }
  };

  const label = room === 0 ? `${MAX_TILES} is the most agents shown together` : "Add agents";
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o && room > 0);
        if (!o) setFailures([]);
      }}
    >
      <Tooltip content={label}>
        <PopoverTrigger asChild>
          <Button
            size={showLabel ? "xs" : "icon-sm"}
            variant="ghost"
            aria-label={showLabel && room > 0 ? undefined : label}
            aria-disabled={room === 0}
            className={cn(room === 0 && "opacity-45")}
          >
            <Plus className={showLabel ? "!h-3.5 !w-3.5" : undefined} />
            {showLabel && "Add agents"}
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="w-[340px] p-3.5">
        <div
          className="space-y-3"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (isMac ? e.metaKey : e.ctrlKey)) {
              e.preventDefault();
              void start();
            }
          }}
        >
          <div className="text-body font-semibold">Add agents to {project}</div>
          <Textarea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should they do? (optional: without it they start idle)"
            aria-label="What the new agents should do"
            className="min-h-[72px]"
          />
          <AgentCount value={count} onChange={setWanted} max={room} disabled={busy} className="w-full" />
          <p className="text-caption leading-snug text-steel">
            Same agent as this one ({via}). Each starts in{" "}
            <span className="font-mono">{prettyPath(agent.projectPath)}</span> in its own worktree.
          </p>
          {isGit === false && (
            <p className="flex items-start gap-1.5 text-caption leading-snug text-warn">
              <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              This folder isn't a git repository with a commit, so worktrees can't be made and the agents will share it
              and can overwrite each other's files.
            </p>
          )}
          {failures.length > 0 && (
            <ul role="alert" className="space-y-0.5 text-caption leading-snug text-err">
              {failures.map((f) => (
                <li key={f} className="selectable break-words">
                  {f}
                </li>
              ))}
            </ul>
          )}
          <Button variant="primary" size="sm" className="w-full" disabled={busy} onClick={() => void start()}>
            {busy && <Spinner className="h-3.5 w-3.5 text-current" />}
            Start {count} {count === 1 ? "agent" : "agents"}
            <span className="ml-1 text-micro opacity-70">{modKey}⏎</span>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
