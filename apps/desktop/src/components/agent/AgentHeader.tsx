import {
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  CalendarClock,
  CalendarPlus,
  Shrink,
  Power,
  Workflow,
  Radio,
  Download,
  Gauge,
  Repeat,
  Ellipsis,
  FolderOpen,
  GitBranch,
  GitCompare,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Play,
  Square,
  SquareTerminal,
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
import { isBusy, liveTail, type SubagentRun } from "@/lib/agents";
import { agentDerived } from "./derived";
import { canCompact, compactContext, contextRatio } from "./compact";
import { api } from "@/lib/api";
import { CUSTOM_ACCOUNT_ID, PROVIDERS } from "@/lib/providers";
import type { Account, Agent, CustomAgent, Provider } from "@/lib/types";
import { basename, cn, modKey, prettyPath } from "@/lib/utils";
import { useIdentity } from "@/hooks/useIdentity";
import { useAgentListLayout } from "@/hooks/useAgentListLayout";
import { useElementWidth } from "@/hooks/useElementWidth";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { INSPECTOR_DOCK_QUERY } from "@/lib/layout";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { AccountAvatar } from "../AccountAvatar";
import { ProviderGlyph } from "../ProviderGlyph";
import { StatusPill } from "../StatusDot";
import { useIsDone } from "@/store/completion";
import { ConfirmDialog } from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/misc";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "../ui/popover";
import { PrChip } from "./PrChip";
import { SubagentList } from "./SubagentList";
import { UsageMeters, pctTextTone, windowLabel } from "../UsageMeter";
import { relativeTimeLong } from "@/lib/format";

const EMPTY_CUSTOM: CustomAgent[] = [];

export function AgentHeader({ agent }: { agent: Agent }) {
  const account = useApp((s) => s.accounts.find((a) => a.id === agent.accountId));
  const identity = useIdentity(agent.provider, agent.customAgentId);
  const done = useIsDone(agent);
  const wide = useMediaQuery(INSPECTOR_DOCK_QUERY);
  const list = useAgentListLayout();
  const [ref, width] = useElementWidth<HTMLElement>();
  // full: labelled buttons · icons: icon buttons · compact: secondary actions live in ⋯
  const tier = width === 0 || width >= 760 ? "full" : width >= 520 ? "icons" : "compact";
  const inspectorPref = useUi((s) => s.inspectorOpen);
  const overlay = useUi((s) => s.inspectorOverlay);
  const inspectorOpen = wide ? inspectorPref : overlay;
  const workspaceOpen = useUi((s) => s.workspaceOpen);
  const toggleInspector = () =>
    wide ? useUi.getState().setInspectorOpen(!inspectorPref) : useUi.getState().setInspectorOverlay(!overlay);
  const setReviewAgent = useUi((s) => s.setReviewAgent);
  const setHandoffAgent = useUi((s) => s.setHandoffAgent);
  const setDeleteAgent = useUi((s) => s.setDeleteAgent);
  const busy = agent.status === "working" || agent.status === "starting" || agent.status === "needs_permission";
  const resumable = agent.status === "interrupted" || agent.status === "stopped";
  const live = agent.status === "working" || agent.status === "starting";
  // Primitive selectors: only re-render when the derived value changes, not on every delta.
  const tail = useApp((s) => (live ? liveTail(s.items[agent.id]) : null));
  const changed = useApp((s) => (agent.worktree ? agentDerived(agent.id, s.items[agent.id]).changedCount : 0));
  const [confirmShutdown, setConfirmShutdown] = useState(false);

  const scheduleThis = () => {
    const first = useApp.getState().items[agent.id]?.find((i) => i.kind === "user_message");
    useUi.getState().openScheduleFor({
      name: agent.title,
      provider: agent.provider,
      accountId: agent.accountId,
      customAgentId: agent.customAgentId,
      projectPath: agent.projectPath,
      prompt: first && first.kind === "user_message" ? first.text : "",
      worktree: agent.worktree,
    });
  };

  return (
    <header
      ref={ref}
      className={cn("shrink-0 border-b border-line bg-panel/40 pb-2.5 pt-3", tier === "compact" ? "px-3" : "px-5")}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {(!list.docked || !list.open) && (
          <Tooltip content="Show agents" shortcut={[modKey, "B"]}>
            <Button size="icon-sm" variant="ghost" aria-label="Show agent list" onClick={list.toggle} className="-ml-1">
              <PanelLeftOpen />
            </Button>
          </Tooltip>
        )}
        <ProviderGlyph provider={agent.provider} customAgentId={agent.customAgentId} size="md" />
        <div className="min-w-0 flex-1">
          <EditableTitle agent={agent} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {busy ? (
            <ActionButton
              tier={tier}
              label="Stop"
              tooltip="Stop this turn"
              shortcut={["Esc"]}
              onClick={() => void cancelTurn(agent)}
            >
              <Square className="!h-3 !w-3 fill-current" />
            </ActionButton>
          ) : resumable ? (
            <ActionButton
              tier={tier}
              label="Resume"
              tooltip="Resume this agent"
              onClick={() => void resumeAgent(agent)}
            >
              <Play className="!h-3.5 !w-3.5" />
            </ActionButton>
          ) : null}
          {agent.worktree && tier !== "compact" && (
            <ReviewPill tier={tier} count={changed} onClick={() => setReviewAgent(agent.id)} />
          )}
          {tier !== "compact" && (
            <HandoffMenu agent={agent} onCustom={() => setHandoffAgent(agent)} showLabel={tier === "full"} />
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="More actions">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {tier === "compact" && (
                <>
                  {agent.worktree && (
                    <DropdownMenuItem onSelect={() => setReviewAgent(agent.id)}>
                      <GitCompare /> Review diff{changed > 0 ? ` (${changed} file${changed === 1 ? "" : "s"})` : "…"}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={() => setHandoffAgent(agent)}>
                    <ArrowRightLeft /> Hand off…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem
                onSelect={() => void attempt("Couldn't open the folder", () => api.openPath(agent.cwd))}
              >
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
              <DropdownMenuItem onSelect={scheduleThis}>
                <CalendarPlus /> Schedule this…
              </DropdownMenuItem>
              {canCompact(agent) && agent.running && (
                <DropdownMenuItem onSelect={() => void compactContext(agent)}>
                  <Shrink /> Compact context
                  {agent.contextSize ? (
                    <span className="ml-auto pl-3 text-[11px] text-steel tabular">
                      {Math.round(contextRatio(agent) * 100)}%
                    </span>
                  ) : null}
                </DropdownMenuItem>
              )}
              {agent.running && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setConfirmShutdown(true)}>
                    <Power /> Shut down agent…
                  </DropdownMenuItem>
                </>
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
          <Tooltip content={workspaceOpen ? "Hide workspace panel" : "Show workspace panel"} shortcut={[modKey, "`"]}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Toggle workspace panel"
              aria-pressed={workspaceOpen}
              onClick={() => useUi.getState().setWorkspaceOpen(!workspaceOpen)}
            >
              <SquareTerminal />
            </Button>
          </Tooltip>
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

      <div
        className={cn(
          "mt-2 flex min-w-0 flex-wrap items-center gap-1.5",
          tier !== "compact" && (!list.docked || !list.open ? "pl-[72px]" : "pl-[38px]"),
        )}
      >
        <StatusPill status={agent.status} done={done} />
        <SubagentsChip agent={agent} />
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
        {agent.provider !== "custom" && account && <UsageChip account={account} compact={tier === "compact"} />}
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
        <PrChip agent={agent} />
      </div>
      {tail && (
        <div
          className={cn(
            "mt-1.5 flex min-w-0 items-center gap-2 text-[12px] text-muted",
            tier !== "compact" && (!list.docked || !list.open ? "pl-[72px]" : "pl-[38px]"),
          )}
        >
          <Spinner className="h-3 w-3 shrink-0" />
          <Tooltip content={tail} side="bottom" align="start">
            <span className="min-w-0 truncate" aria-live="off">
              {tail}
            </span>
          </Tooltip>
        </div>
      )}
      <ConfirmDialog
        open={confirmShutdown}
        onOpenChange={setConfirmShutdown}
        title="Shut down this agent?"
        description="This ends the agent's process. The session is saved: Resume brings it back with its full history. To only end the current turn, use Stop instead."
        confirmLabel="Shut down"
        danger
        onConfirm={async () => {
          setConfirmShutdown(false);
          await stopAgent(agent);
        }}
      />
    </header>
  );
}

/** Header "Review diff" pill: changed-file count for worktree agents. */
function ReviewPill({
  tier,
  count,
  onClick,
}: {
  tier: "full" | "icons" | "compact";
  count: number;
  onClick: () => void;
}) {
  const label = count > 0 ? `${count} file${count === 1 ? "" : "s"} changed` : "No changes yet";
  return (
    <Tooltip content={`Review diff · ${label}`}>
      <Button
        size={tier === "full" ? "sm" : "icon-sm"}
        variant="secondary"
        onClick={onClick}
        aria-label={`Review diff, ${label}`}
        className={cn("relative", tier === "full" && "gap-1.5")}
      >
        <GitCompare className="!h-3.5 !w-3.5" />
        {tier === "full" && <span>Review</span>}
        {count > 0 &&
          (tier === "full" ? (
            <span className="rounded-full bg-accent/15 px-1.5 text-[10.5px] font-semibold text-accent tabular">
              {count}
            </span>
          ) : (
            <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9px] font-bold text-accent-fg tabular">
              {count}
            </span>
          ))}
      </Button>
    </Tooltip>
  );
}

function UsageChip({ account, compact }: { account: Account; compact: boolean }) {
  const usage = account.usage;
  const rawPlan = usage?.plan ?? null;
  const plan = account.status?.label ?? (rawPlan ? rawPlan.charAt(0).toUpperCase() + rawPlan.slice(1) : null);
  const windows = [usage?.primary, usage?.secondary].filter((w): w is NonNullable<typeof w> => !!w);
  if (!plan && windows.length === 0) return null;
  const short = (w: (typeof windows)[number]) => (w.windowMins === 300 ? "5h" : windowLabel(w).replace(" window", ""));
  const shortLabel = (w: (typeof windows)[number]) => (w.windowMins === 10080 ? "Week" : short(w));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Plan and usage limits${plan ? `, ${plan}` : ""}`}
          className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border border-line bg-card/60 px-2 text-[11.5px] transition-colors hover:bg-raised/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent/25"
        >
          <Gauge className="h-3 w-3 shrink-0 text-steel" />
          {!compact && plan && <span className="truncate text-fg/90">{plan}</span>}
          {windows.map((w) => {
            const pct = Math.max(0, Math.min(100, Math.round(w.usedPercent)));
            return (
              <span key={w.windowMins ?? "w"} className="tabular text-muted">
                {!compact && <>{shortLabel(w)} </>}
                <span className={cn("font-medium", pctTextTone(pct))}>{pct}%</span>
              </span>
            );
          })}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <div className="mb-2 text-[12px] font-medium text-fg">{plan ?? "Usage limits"}</div>
        {windows.length > 0 ? (
          <UsageMeters usage={usage} compact />
        ) : (
          <div className="text-[11.5px] text-steel">Limits appear after the first reply.</div>
        )}
        {usage && windows.length > 0 && (
          <div className="mt-2 text-[10.5px] text-steel">Updated {relativeTimeLong(usage.updatedAt)}</div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** "N sub-agents running" chip; opens the list of this agent's sub-agents. Hidden when it has none. */
function SubagentsChip({ agent }: { agent: Agent }) {
  const live = isBusy(agent);
  const runs = useApp((s) => (live ? agentDerived(agent.id, s.items[agent.id], true).subagents : NO_RUNS));
  const running = runs.filter((r) => r.state === "running").length;
  if (running === 0) return null;
  return (
    <Popover>
      <Tooltip content="Sub-agents working in parallel inside this turn">
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border border-accent/30 bg-accent/[0.08] px-2 text-[11.5px] text-accent transition-colors hover:border-accent/50 hover:bg-accent/15"
          >
            <Workflow className="h-3 w-3" />
            <span className="tabular">{running}</span> sub-agent{running === 1 ? "" : "s"} running
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="start" className="w-[340px] p-1.5">
        <div className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-steel">
          Sub-agents
        </div>
        <div className="max-h-[360px] overflow-y-auto">
          <PopoverClose asChild>
            <div>
              <SubagentList runs={runs} onSelect={(r) => useUi.getState().revealItem(agent.id, r.itemId)} />
            </div>
          </PopoverClose>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const NO_RUNS: SubagentRun[] = [];

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

  // Each edit session ends exactly once: Enter commits, Esc cancels, blur commits only if
  // neither happened (so Esc→blur doesn't save and Enter→blur doesn't save twice).
  const settled = useRef(false);
  useEffect(() => {
    if (editing) {
      settled.current = false;
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = async () => {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    const t = value.trim();
    if (t && t !== agent.title) await renameAgent(agent, t);
    else setValue(agent.title);
  };

  const cancel = () => {
    settled.current = true;
    setValue(agent.title);
    setEditing(false);
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
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cancel();
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
      title={agent.title}
      className="group -ml-1.5 flex min-h-8 max-w-full items-center gap-2 rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-raised/60"
    >
      <h1 className="line-clamp-2 break-words text-[15.5px] font-semibold leading-snug tracking-[-0.015em] text-fg">
        {agent.title}
      </h1>
      <Pencil className="h-3.5 w-3.5 shrink-0 text-steel opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

function HandoffMenu({ agent, onCustom, showLabel }: { agent: Agent; onCustom: () => void; showLabel: boolean }) {
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
            {showLabel && <span>Hand off</span>}
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

function ActionButton({
  tier,
  label,
  tooltip,
  shortcut,
  onClick,
  children,
}: {
  tier: "full" | "icons" | "compact";
  label: string;
  tooltip: string;
  shortcut?: string[];
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={tooltip} shortcut={shortcut}>
      {tier === "full" ? (
        // The visible label is the accessible name (the tooltip adds detail).
        <Button size="sm" variant="secondary" onClick={onClick}>
          {children}
          {label}
        </Button>
      ) : (
        <Button size="icon-sm" variant="secondary" aria-label={tooltip} onClick={onClick}>
          {children}
        </Button>
      )}
    </Tooltip>
  );
}
