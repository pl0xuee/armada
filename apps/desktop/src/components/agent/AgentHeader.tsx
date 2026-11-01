import {
  FolderCog,
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  CalendarPlus,
  Shrink,
  Power,
  Radio,
  Download,
  Gauge,
  Repeat,
  Ellipsis,
  FolderOpen,
  GitCompare,
  Globe,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Play,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { archiveAgent, attempt, exportConversation, renameAgent, resumeAgent, stopAgent } from "@/lib/actions";
import { liveTail } from "@/lib/agents";
import { agentDerived } from "./derived";
import { canCompact, compactContext, contextRatio } from "./compact";
import { api } from "@/lib/api";
import { CUSTOM_ACCOUNT_ID, PROVIDERS } from "@/lib/providers";
import type { Agent, CustomAgent, Provider } from "@/lib/types";
import { basename, cn, modKey } from "@/lib/utils";
import { useAgentListLayout } from "@/hooks/useAgentListLayout";
import { useElementWidth } from "@/hooks/useElementWidth";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { INSPECTOR_DOCK_QUERY } from "@/lib/layout";
import { selectFromAgents } from "@/lib/memoSelector";
import { useApp } from "@/store/app";
import { hasNewServer, previewOf, togglePreview, usePreview } from "@/store/preview";
import { openProjectSettings } from "@/store/projectSettings";
import { useUi } from "@/store/ui";
import { ProviderGlyph } from "../ProviderGlyph";
import { StatusDot, StatusPill } from "../StatusDot";
import { AddAgents } from "./AddAgents";
import { BudgetChip } from "./BudgetChip";
import { STATUS } from "@/lib/providers";
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
import { PrChip } from "./PrChip";
import { HelperOfLine, HelpersChip, SyncChip, TileToggle } from "./HelperBits";

const EMPTY_CUSTOM: CustomAgent[] = [];

/** Opens / closes the right-side Preview pane; shown while a dev server is live (or the pane is open). */
function PreviewChip({ agentId, showLabel }: { agentId: string; showLabel: boolean }) {
  const open = usePreview((s) => previewOf(s, agentId).open);
  const hasLive = usePreview((s) => previewOf(s, agentId).live.length > 0);
  const fresh = usePreview((s) => hasNewServer(previewOf(s, agentId)));
  if (!open && !hasLive) return null;
  const label = open ? "Close preview" : fresh ? "Open preview (new server detected)" : "Open preview";
  return (
    <Tooltip content={label} shortcut={[modKey, "⇧", "P"]}>
      <Button
        size={showLabel ? "xs" : "icon-sm"}
        variant={open ? "secondary" : "ghost"}
        aria-label={label}
        aria-pressed={open}
        onClick={() => togglePreview(agentId)}
        className="relative"
      >
        <Globe className={showLabel ? "!h-3.5 !w-3.5" : undefined} />
        {showLabel && "Preview"}
        {fresh && !open && (
          <span
            className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent ring-2 ring-base"
            role="img"
            aria-label="New server detected"
          />
        )}
      </Button>
    </Tooltip>
  );
}

/** How a header behaves as one tile of a tiled helper group. */
export interface HeaderTile {
  /** The focused tile owns the inspector and preview. */
  focused: boolean;
  /** First tile: carries the agent-list toggle. */
  first: boolean;
  /** 1-based position among the agents shown together. */
  index?: number;
}

function AgentHeaderImpl({ agent, tile }: { agent: Agent; tile?: HeaderTile }) {
  const account = useApp((s) => s.accounts.find((a) => a.id === agent.accountId));
  const done = useIsDone(agent);
  const wide = useMediaQuery(INSPECTOR_DOCK_QUERY);
  const list = useAgentListLayout();
  const [ref, width] = useElementWidth<HTMLElement>();
  // full: labelled buttons · icons: icon buttons · compact: secondary actions live in ⋯
  const tier = tile ? "compact" : width === 0 || width >= 1000 ? "full" : width >= 600 ? "icons" : "compact";
  // Live helpers (for a main agent): drives the "N helpers" chip and the tile toggle.
  const agentId = agent.id;
  const isHelper = !!agent.parentId;
  const helperCount = useApp(
    useMemo(
      () =>
        selectFromAgents((agents) =>
          isHelper ? 0 : Object.values(agents).filter((a) => a.parentId === agentId && !a.archived).length,
        ),
      [agentId, isHelper],
    ),
  );
  const inGroup = helperCount > 0 || !!agent.parentId;
  const inspectorPref = useUi((s) => s.inspectorOpen);
  const overlay = useUi((s) => s.inspectorOverlay);
  const inspectorOpen = wide ? inspectorPref : overlay;
  const workspaceOpen = useUi((s) => s.workspaceOpen);
  const workspaceRoom = useUi((s) => s.workspaceRoom);
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
    <header ref={ref} className={cn("shrink-0 border-b border-line bg-panel/40", tier === "compact" ? "px-3" : "px-5")}>
      {/* Fixed height: title + one meta line on the left, status/chips/actions on the right.
          Nothing wraps, so switching agents or states never moves the conversation. */}
      <div className="flex h-[58px] min-w-0 items-center gap-2.5">
        {(!list.docked || !list.open) && (!tile || tile.first) && (
          <Tooltip content="Show agents" shortcut={[modKey, "B"]}>
            <Button size="icon-sm" variant="ghost" aria-label="Show agent list" onClick={list.toggle} className="-ml-1">
              <PanelLeftOpen />
            </Button>
          </Tooltip>
        )}
        {tile?.index && (
          <span
            className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md border border-line-strong bg-card px-1 text-[11px] font-semibold text-muted tabular"
            aria-label={`Agent ${tile.index}`}
          >
            {tile.index}
          </span>
        )}
        <ProviderGlyph provider={agent.provider} customAgentId={agent.customAgentId} size="md" />
        <div className="min-w-0 flex-1">
          <EditableTitle agent={agent} />
          <div className="flex h-4 min-w-0 items-center gap-1.5 text-[11.5px] leading-none text-steel">
            {agent.parentId ? (
              <>
                <HelperOfLine agent={agent} />
                <SyncChip agent={agent} />
              </>
            ) : tail ? (
              <>
                <Spinner className="h-3 w-3 shrink-0" />
                <Tooltip content={tail} side="bottom" align="start">
                  <span className="min-w-0 truncate text-muted" aria-live="off">
                    {tail}
                  </span>
                </Tooltip>
              </>
            ) : (
              <span className="min-w-0 truncate">
                {basename(agent.projectPath)}
                {agent.branch && (
                  <>
                    <span className="mx-1.5 text-line-strong">·</span>
                    <span className="font-mono text-[11px]">{agent.branch}</span>
                    {agent.baseBranch && <span className="font-mono text-[11px]"> → {agent.baseBranch}</span>}
                  </>
                )}
                {account && agent.provider !== "custom" && (
                  <>
                    <span className="mx-1.5 text-line-strong">·</span>
                    {account.name}
                  </>
                )}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {tile || (tier === "compact" && inGroup) ? (
            <Tooltip content={done ? "Done" : STATUS[agent.status].label}>
              <span
                className="flex h-6 w-5 items-center justify-center"
                role="img"
                aria-label={STATUS[agent.status].label}
              >
                <StatusDot status={agent.status} size={8} done={done} />
              </span>
            </Tooltip>
          ) : (
            <StatusPill status={agent.status} done={done} />
          )}
          {helperCount > 0 && <HelpersChip count={helperCount} label={tier !== "compact"} />}
          {agent.rateLimited && (
            <Chip className="border-warn/35 bg-warn/10 text-warn">
              <Gauge className="h-3 w-3" />
              {tier === "compact" ? "Limit" : "Usage limit"}
            </Chip>
          )}
          <BudgetChip agent={agent} compact={tier === "compact"} always />
          {!tile && tier !== "compact" && <PrChip agent={agent} />}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {resumable && !busy ? (
            <ActionButton
              tier={tier === "icons" ? "full" : tier}
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
          {(!tile || tile.focused) && <PreviewChip agentId={agent.id} showLabel={tier === "full"} />}
          {(!tile || tile.focused) && <AddAgents agent={agent} showLabel={tier === "full"} />}
          {agent.parentId && <TileToggle />}
          {!tile && (
            <>
              <Tooltip
                content={
                  workspaceOpen
                    ? workspaceRoom === 0
                      ? "Hide workspace panel (not enough room to show it)"
                      : "Hide workspace panel"
                    : workspaceRoom === 0
                      ? "Show workspace panel (window is small)"
                      : "Show workspace panel"
                }
                shortcut={[modKey, "`"]}
              >
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
            </>
          )}
          {(!tile || tile.focused) && (
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
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="More actions">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {tier === "compact" && agent.worktree && (
                <DropdownMenuItem onSelect={() => setReviewAgent(agent.id)}>
                  <GitCompare /> Review diff{changed > 0 ? ` (${changed} file${changed === 1 ? "" : "s"})` : "…"}
                </DropdownMenuItem>
              )}
              <HandoffSub agent={agent} onCustom={() => setHandoffAgent(agent)} />
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => void attempt("Couldn't open the folder", () => api.openPath(agent.cwd))}
              >
                <FolderOpen /> Open folder
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openProjectSettings(agent.projectPath)}>
                <FolderCog /> Project settings…
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
        </div>
      </div>

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
            <span className="rounded-full bg-accent/15 px-1.5 text-[11px] font-semibold text-accent tabular">
              {count}
            </span>
          ) : (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[11px] font-bold text-accent-fg tabular">
              {count}
            </span>
          ))}
      </Button>
    </Tooltip>
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
        className="-ml-1.5 h-6 w-full rounded-md border border-accent/50 bg-base/60 px-1.5 text-[16px] font-semibold tracking-tight text-fg focus:outline-none focus:ring-3 focus:ring-accent/15"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title={agent.title}
      className="group -ml-1.5 flex h-6 max-w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-raised/60"
    >
      <h1 className="truncate text-[15.5px] font-semibold leading-snug tracking-[-0.015em] text-fg">{agent.title}</h1>
      <Pencil className="h-3.5 w-3.5 shrink-0 text-steel opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

/** "Hand off" submenu of the More menu: a quick second opinion from another account, or with instructions. */
function HandoffSub({ agent, onCustom }: { agent: Agent; onCustom: () => void }) {
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
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <ArrowRightLeft /> Hand off
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuLabel>Second opinion</DropdownMenuLabel>
        {others.slice(0, 5).map((a) => (
          <DropdownMenuItem key={a.id} onSelect={() => void quick(a.provider, a.id, null)}>
            <ProviderGlyph provider={a.provider} size="xs" />
            <span className="truncate">Ask {PROVIDERS[a.provider].short}</span>
            <span className="ml-auto truncate pl-3 text-[11px] text-steel">{a.name}</span>
          </DropdownMenuItem>
        ))}
        {customs.slice(0, 3).map((c) => (
          <DropdownMenuItem key={c.id} onSelect={() => void quick("custom", CUSTOM_ACCOUNT_ID, c.id)}>
            <ProviderGlyph provider="custom" customAgentId={c.id} size="xs" />
            <span className="truncate">Ask {c.name}</span>
            <span className="ml-auto truncate pl-3 text-[11px] text-steel">ACP</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onCustom}>
          <ArrowRightLeft /> Hand off with instructions…
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
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

export const AgentHeader = memo(AgentHeaderImpl);
