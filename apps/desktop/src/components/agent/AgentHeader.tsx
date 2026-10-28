import {
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  CalendarClock,
  Radio,
  Download,
  Gauge,
  Repeat,
  Ellipsis,
  FolderOpen,
  GitBranch,
  GitCompare,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Play,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  archiveAgent,
  attempt,
  exportConversation,
  renameAgent,
  cancelTurn,
  resumeAgent,
  stopAgent,
} from "@/lib/actions";
import { api } from "@/lib/api";
import { CUSTOM_ACCOUNT_ID, PROVIDERS } from "@/lib/providers";
import type { Agent, CustomAgent, Provider } from "@/lib/types";

const EMPTY_CUSTOM: CustomAgent[] = [];
import { basename, cn, prettyPath } from "@/lib/utils";
import { useIdentity } from "@/hooks/useIdentity";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { AccountAvatar } from "../AccountAvatar";
import { ProviderGlyph } from "../ProviderGlyph";
import { StatusPill } from "../StatusDot";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/menu";
import { Tooltip } from "../ui/tooltip";

export function AgentHeader({ agent }: { agent: Agent }) {
  const account = useApp((s) => s.accounts.find((a) => a.id === agent.accountId));
  const identity = useIdentity(agent.provider, agent.customAgentId);
  const wide = useMediaQuery("(min-width: 1180px)");
  const inspectorPref = useUi((s) => s.inspectorOpen);
  const overlay = useUi((s) => s.inspectorOverlay);
  const inspectorOpen = wide ? inspectorPref : overlay;
  const toggleInspector = () =>
    wide ? useUi.getState().setInspectorOpen(!inspectorPref) : useUi.getState().setInspectorOverlay(!overlay);
  const setReviewAgent = useUi((s) => s.setReviewAgent);
  const setHandoffAgent = useUi((s) => s.setHandoffAgent);
  const setDeleteAgent = useUi((s) => s.setDeleteAgent);
  const busy = agent.status === "working" || agent.status === "starting" || agent.status === "needs_permission";
  const resumable = agent.status === "interrupted" || agent.status === "stopped";

  return (
    <header className="shrink-0 border-b border-line bg-panel/40 px-5 pb-2.5 pt-3">
      <div className="flex min-w-0 items-center gap-3">
        <ProviderGlyph provider={agent.provider} customAgentId={agent.customAgentId} size="md" />
        <div className="min-w-0 flex-1">
          <EditableTitle agent={agent} />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {busy ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void cancelTurn(agent)}
              aria-label="Cancel current turn"
            >
              <Square className="!h-3 !w-3 fill-current" />
              <span className="hidden md:inline">Cancel</span>
            </Button>
          ) : resumable ? (
            <Button size="sm" variant="secondary" onClick={() => void resumeAgent(agent)}>
              <Play className="!h-3.5 !w-3.5" />
              <span className="hidden md:inline">Resume</span>
            </Button>
          ) : null}
          {agent.worktree && (
            <Button size="sm" variant="secondary" onClick={() => setReviewAgent(agent.id)}>
              <GitCompare className="!h-3.5 !w-3.5" />
              <span className="hidden md:inline">Review</span>
            </Button>
          )}
          <HandoffMenu agent={agent} onCustom={() => setHandoffAgent(agent)} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="More actions">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void api.openPath(agent.cwd)}>
                <FolderOpen /> Open folder
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportConversation(agent)}>
                <Download /> Export conversation…
              </DropdownMenuItem>
              {agent.provider !== "custom" && (
                <DropdownMenuItem onSelect={() => useUi.getState().setMoveAgent(agent)}>
                  <Repeat /> Move to another account…
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => useUi.getState().setShareAgent(agent)}>
                <Radio /> Share live view…
              </DropdownMenuItem>
              {agent.running && (
                <DropdownMenuItem onSelect={() => void stopAgent(agent)}>
                  <Square /> Stop agent
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => void archiveAgent(agent, !agent.archived)}>
                {agent.archived ? <ArchiveRestore /> : <Archive />}
                {agent.archived ? "Unarchive" : "Archive"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem danger onSelect={() => setDeleteAgent(agent)}>
                <Trash2 /> Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip content={inspectorOpen ? "Hide inspector" : "Show inspector"}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Toggle inspector"
              aria-pressed={inspectorOpen}
              onClick={toggleInspector}
            >
              {inspectorOpen ? <PanelRightClose /> : <PanelRightOpen />}
            </Button>
          </Tooltip>
        </div>
      </div>

      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 pl-[38px]">
        <StatusPill status={agent.status} />
        {agent.rateLimited && (
          <Chip className="border-warn/35 bg-warn/10 text-warn">
            <Gauge className="h-3 w-3" />
            Usage limit
          </Chip>
        )}
        {agent.scheduleId && (
          <Tooltip content="Started by a schedule">
            <Chip>
              <CalendarClock className="h-3 w-3 text-steel" />
              <span className="text-fg/90">Scheduled</span>
            </Chip>
          </Tooltip>
        )}
        {agent.provider === "custom" ? (
          <Chip>
            <span className="h-2 w-2 rounded-full" style={{ background: identity.color }} />
            <span className="text-fg/90">{identity.name}</span>
            <span className="text-muted">ACP</span>
          </Chip>
        ) : (
          account && (
            <Chip>
              <AccountAvatar account={account} size={14} showProvider={false} />
              <span className="text-muted">{identity.short}</span>
              <span className="text-fg/90">{account.name}</span>
            </Chip>
          )
        )}
        <Tooltip content={prettyPath(agent.projectPath)}>
          <Chip>
            <FolderOpen className="h-3 w-3 text-steel" />
            <span className="text-fg/90">{basename(agent.projectPath)}</span>
          </Chip>
        </Tooltip>
        {agent.branch && (
          <Tooltip content={agent.worktree ? `Worktree: ${prettyPath(agent.cwd)}` : "Branch"}>
            <Chip>
              <GitBranch className="h-3 w-3 text-steel" />
              <span className="max-w-[180px] truncate font-mono text-[11px] text-fg/90">{agent.branch}</span>
              {agent.baseBranch && <span className="font-mono text-[11px] text-steel">→ {agent.baseBranch}</span>}
            </Chip>
          </Tooltip>
        )}
      </div>
    </header>
  );
}

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border border-line bg-card/60 px-2 text-[11.5px]",
        className,
      )}
    >
      {children}
    </span>
  );
}

function EditableTitle({ agent }: { agent: Agent }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(agent.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setValue(agent.title);
  }, [agent.title, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = async () => {
    setEditing(false);
    const t = value.trim();
    if (t && t !== agent.title) await renameAgent(agent, t);
    else setValue(agent.title);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={value}
        aria-label="Agent title"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit();
          if (e.key === "Escape") {
            e.stopPropagation();
            setValue(agent.title);
            setEditing(false);
          }
        }}
        className="-ml-1.5 h-8 w-full rounded-md border border-accent/50 bg-base/60 px-1.5 text-[16px] font-semibold tracking-tight text-fg focus:outline-none focus:ring-3 focus:ring-accent/15"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Rename"
      className="group -ml-1.5 flex h-8 max-w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-raised/60"
    >
      <h1 className="truncate text-[16px] font-semibold tracking-[-0.015em] text-fg">{agent.title}</h1>
      <Pencil className="h-3.5 w-3.5 shrink-0 text-steel opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

function HandoffMenu({ agent, onCustom }: { agent: Agent; onCustom: () => void }) {
  const accounts = useApp((s) => s.accounts);
  const openAgent = useUi((s) => s.openAgent);
  const customAgents = useApp((s) => s.settings?.customAgents ?? EMPTY_CUSTOM);
  const others = accounts.filter((a) => a.id !== agent.accountId && a.status?.loggedIn !== false);
  const customs = customAgents.filter((c) => c.enabled && c.id !== agent.customAgentId);
  const instruction = `Review the work done so far on "${agent.title}" and give a critical second opinion. Point out bugs, risks and simpler alternatives.`;

  const quick = async (provider: Provider, accountId: string, customAgentId: string | null) => {
    const created = await attempt("Hand-off failed", () =>
      api.handoffAgent(agent.id, provider, accountId, instruction, customAgentId),
    );
    if (created) openAgent(created.id);
  };

  return (
    <DropdownMenu>
      <Tooltip content="Hand off to another agent">
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" aria-label="Hand off">
            <ArrowRightLeft className="!h-3.5 !w-3.5" />
            <span className="hidden lg:inline">Hand off</span>
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Second opinion</DropdownMenuLabel>
        {others.slice(0, 5).map((a) => (
          <DropdownMenuItem key={a.id} onSelect={() => void quick(a.provider, a.id, null)}>
            <ProviderGlyph provider={a.provider} size="xs" />
            <span className="truncate">Ask {PROVIDERS[a.provider].short}</span>
            <span className="ml-auto truncate text-[11px] text-steel">{a.name}</span>
          </DropdownMenuItem>
        ))}
        {customs.slice(0, 3).map((c) => (
          <DropdownMenuItem key={c.id} onSelect={() => void quick("custom", CUSTOM_ACCOUNT_ID, c.id)}>
            <ProviderGlyph provider="custom" customAgentId={c.id} size="xs" />
            <span className="truncate">Ask {c.name}</span>
            <span className="ml-auto truncate text-[11px] text-steel">ACP</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onCustom}>
          <ArrowRightLeft /> Hand off with instructions…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
