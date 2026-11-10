import {
  FolderCog,
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  CalendarPlus,
  Columns2,
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
  Plus,
  Pencil,
  Play,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { archiveAgent, attempt, exportConversation, renameAgent, resumeAgent, stopAgent } from "@/lib/actions";
import { liveTail } from "@/lib/agents";
import { resumesShort } from "@/lib/limitResume";
import { agentDerived } from "./derived";
import { headerFold } from "./headerFold";
import { canCompact, compactContext, contextRatio } from "./compact";
import { api } from "@/lib/api";
import { CUSTOM_ACCOUNT_ID, PROVIDERS } from "@/lib/providers";
import type { Agent, CustomAgent, Provider } from "@/lib/types";
import { basename, cn, modKey } from "@/lib/utils";
import { useAgentListLayout } from "@/hooks/useAgentListLayout";
import { useElementWidth } from "@/hooks/useElementWidth";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { MAX_TILES, tileIdsFor } from "@/lib/helpers";
import { headerTier, INSPECTOR_DOCK_QUERY } from "@/lib/layout";
import { selectFromAgents } from "@/lib/memoSelector";
import { useApp } from "@/store/app";
import { hasNewServer, previewOf, togglePreview, usePreview } from "@/store/preview";
import { openToolkit } from "@/store/toolkit";
import { useUi } from "@/store/ui";
import { ProviderGlyph } from "../ProviderGlyph";
import { StatusDot, StatusPill } from "../StatusDot";
import { AccountSwitcher } from "./AccountSwitcher";
import { AddAgents } from "./AddAgents";
import { BudgetChip } from "./BudgetChip";
import { STATUS } from "@/lib/providers";
import { useStatusView } from "@/store/background";
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
import { ResumesAt } from "./ResumesAt";
import { HelperOfLine, HelpersChip, SyncChip, TileToggle } from "./HelperBits";

const EMPTY_CUSTOM: CustomAgent[] = [];

/** Whether the Preview pane is open, a dev server is live, and one of them is new. Primitives: no render per frame. */
function usePreviewStatus(agentId: string) {
  const open = usePreview((s) => previewOf(s, agentId).open);
  const hasLive = usePreview((s) => previewOf(s, agentId).live.length > 0);
  const fresh = usePreview((s) => hasNewServer(previewOf(s, agentId)));
  const available = open || hasLive;
  const label = open ? "Close preview" : fresh ? "Open preview (new server detected)" : "Open preview";
  return { open, available, fresh: fresh && !open, label };
}

/** Opens / closes the right-side Preview pane; shown while a dev server is live (or the pane is open). */
function PreviewChip({ agentId, showLabel }: { agentId: string; showLabel: boolean }) {
  const { open, available, fresh, label } = usePreviewStatus(agentId);
  if (!available) return null;
  return (
    <Tooltip content={label} shortcut={[modKey, "⇧", "P"]}>
      <Button
        size={showLabel ? "sm" : "icon"}
        variant={open ? "secondary" : "ghost"}
        aria-label={label}
        aria-pressed={open}
        onClick={() => togglePreview(agentId)}
        className="relative"
      >
        <Globe className={showLabel ? "!h-3.5 !w-3.5" : undefined} />
        {showLabel && "Preview"}
        {fresh && (
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
  const view = useStatusView(agent);
  const { done } = view;
  const wide = useMediaQuery(INSPECTOR_DOCK_QUERY);
  const list = useAgentListLayout();
  const [ref, width] = useElementWidth<HTMLElement>();
  // full: labelled buttons · icons: icon buttons · compact: secondary actions live in ⋯
  const tier = headerTier(width, !!tile);
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
  const [renaming, setRenaming] = useState(false);
  // "Add agents" lives in the ⋯ menu; its popover keeps its own (hidden) anchor button next to ⋯.
  const addRef = useRef<HTMLSpanElement>(null);
  const keepFocus = useRef(true);
  const tileGroup = useUi((s) => s.tileGroup);
  const tileHelpers = useUi((s) => s.tileHelpers);
  const shownCount = useApp((s) => tileIdsFor(s.agents, agent.id, tileGroup, tileHelpers).length);
  const addRoom = MAX_TILES - Math.max(1, shownCount);
  // Narrow headers (a tile in a 2-up grid is about 400px) drop the budget chip, then the account chip, and fold
  // every secondary button into ⋯, so the title always keeps room.
  const { noBudget, tight } = headerFold(width);
  const ownsPanels = !tile || tile.focused;
  const preview = usePreviewStatus(agent.id);
  const iconSize = tier === "compact" ? "icon-sm" : "icon";
  // Whether the ⋯ menu leads with the folded buttons (Review, Preview, side panel, tiled helpers).
  const folded = tight && (!!agent.worktree || ownsPanels || helperCount > 0 || isHelper);
  const newServer = tight && ownsPanels && preview.fresh;
  const moreLabel = newServer ? "More actions (new server detected)" : "More actions";

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
      className={cn("relative shrink-0 border-b border-line bg-panel/40", tier === "compact" ? "px-3" : "px-5")}
    >
      {/* Fixed height: title + one meta line on the left, status/chips/actions on the right.
          Nothing wraps, so switching agents or states never moves the conversation. */}
      <div className={cn("flex h-[58px] min-w-0 items-center", tight ? "gap-2" : "gap-2.5")}>
        {(!list.docked || !list.open) && (!tile || tile.first) && (
          <Tooltip content="Show agents" shortcut={[modKey, "B"]}>
            <Button size="icon" variant="ghost" aria-label="Show agent list" onClick={list.toggle} className="-ml-1">
              <PanelLeftOpen />
            </Button>
          </Tooltip>
        )}
        {tile?.index && (
          <span
            className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md border border-line-strong bg-card px-1 text-micro font-semibold text-muted tabular"
            aria-label={`Agent ${tile.index}`}
          >
            {tile.index}
          </span>
        )}
        <ProviderGlyph provider={agent.provider} customAgentId={agent.customAgentId} size="md" />
        <div className="min-w-[104px] flex-1">
          <EditableTitle agent={agent} editing={renaming} setEditing={setRenaming} />
          <div className="flex h-4 min-w-0 items-center gap-1.5 text-xs leading-none text-steel">
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
                    <span className="font-mono text-xs">{agent.branch}</span>
                    {agent.baseBranch && <span className="font-mono text-xs"> → {agent.baseBranch}</span>}
                  </>
                )}
                {account && agent.provider !== "custom" && tile && !tile.focused && (
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
          {tile || tight || (tier === "compact" && inGroup) ? (
            <Tooltip content={view.detail ? `${view.pill}. ${view.detail}` : view.meta.label}>
              <span
                className="flex h-6 w-5 items-center justify-center"
                role="img"
                aria-label={view.background ? view.pill : STATUS[agent.status].label}
              >
                <StatusDot status={view.dot} size={8} done={done} />
              </span>
            </Tooltip>
          ) : view.background ? (
            <Tooltip content={view.detail}>
              <span className="inline-flex min-w-0 max-w-[280px]">
                <StatusPill status="working" label={view.pill} className="h-7 text-xs" />
              </span>
            </Tooltip>
          ) : (
            <StatusPill status={agent.status} done={done} className="h-7 text-xs" />
          )}
          {helperCount > 0 && !tight && <HelpersChip count={helperCount} label={tier !== "compact"} />}
          {agent.rateLimited &&
            (tight ? (
              <LimitMark agent={agent} />
            ) : (
              <Chip className="border-warn/35 bg-warn/10 text-warn">
                <Gauge className="h-3 w-3" />
                <ResumesAt agent={agent} fallback={tier === "full" ? "Rate limited" : "Limit"} />
              </Chip>
            ))}
          {agent.provider !== "custom" && (!tile || tile.focused) && !tight && (
            <AccountSwitcher agent={agent} showName={tier === "full"} />
          )}
          {!noBudget && <BudgetChip agent={agent} compact={tier !== "full"} always />}
          {!tile && tier !== "compact" && <PrChip agent={agent} compact={tier !== "full"} />}
        </div>
        <div className="relative flex shrink-0 items-center gap-1">
          {resumable && !busy ? (
            <ActionButton
              tier={tier === "full" || tier === "icons" ? "full" : "compact"}
              label="Resume"
              tooltip="Resume this agent"
              onClick={() => void resumeAgent(agent)}
            >
              <Play className="!h-3.5 !w-3.5" />
            </ActionButton>
          ) : null}
          {agent.worktree && !tight && (
            <ReviewPill tier={tier} count={changed} onClick={() => setReviewAgent(agent.id)} />
          )}
          {ownsPanels && !tight && <PreviewChip agentId={agent.id} showLabel={tier === "full"} />}
          {agent.parentId && !tight && <TileToggle />}
          {ownsPanels && !tight && (
            <Tooltip content={inspectorOpen ? "Hide the side panel" : "Show the side panel"}>
              <Button
                size={iconSize}
                variant="ghost"
                aria-label={inspectorOpen ? "Hide side panel" : "Show side panel"}
                aria-pressed={inspectorOpen}
                onClick={toggleInspector}
              >
                {inspectorOpen ? <PanelRightClose /> : <PanelRightOpen />}
              </Button>
            </Tooltip>
          )}
          <DropdownMenu>
            <Tooltip content={moreLabel}>
              <DropdownMenuTrigger asChild>
                <Button size={iconSize} variant="ghost" aria-label={moreLabel} className="relative">
                  <Ellipsis />
                  {newServer && (
                    <span
                      className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent ring-2 ring-base"
                      aria-hidden
                    />
                  )}
                </Button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(e) => {
                // The Add agents popover is opening: keep focus off the ⋯ button so it stays open.
                if (!keepFocus.current) e.preventDefault();
                keepFocus.current = true;
              }}
            >
              {/* Narrow header: what the buttons would have shown lives here, so the title keeps the room. */}
              {tight && agent.worktree && (
                <DropdownMenuItem onSelect={() => setReviewAgent(agent.id)}>
                  <GitCompare /> Review changes{changed > 0 ? ` (${changed} file${changed === 1 ? "" : "s"})` : "…"}
                </DropdownMenuItem>
              )}
              {tight && ownsPanels && preview.available && (
                <DropdownMenuItem shortcut={`${modKey}+Shift+P`} onSelect={() => togglePreview(agent.id)}>
                  <Globe /> {preview.label}
                </DropdownMenuItem>
              )}
              {tight && ownsPanels && (
                <DropdownMenuItem onSelect={toggleInspector}>
                  {inspectorOpen ? <PanelRightClose /> : <PanelRightOpen />}
                  {inspectorOpen ? "Hide side panel" : "Show side panel"}
                </DropdownMenuItem>
              )}
              {tight && (helperCount > 0 || isHelper) && (
                <DropdownMenuItem onSelect={() => useUi.getState().setTileHelpers(!tileHelpers)}>
                  <Columns2 />
                  {tileHelpers
                    ? "Show one pane"
                    : isHelper
                      ? "Tile helpers"
                      : `Tile ${helperCount} helper${helperCount === 1 ? "" : "s"}`}
                </DropdownMenuItem>
              )}
              {folded && <DropdownMenuSeparator />}
              {ownsPanels && (
                <DropdownMenuItem
                  disabled={addRoom <= 0}
                  onSelect={() => {
                    keepFocus.current = false;
                    setTimeout(() => addRef.current?.querySelector("button")?.click(), 0);
                  }}
                >
                  <Plus /> {addRoom <= 0 ? `Add agents (${MAX_TILES} is the most shown)` : "Add agents…"}
                </DropdownMenuItem>
              )}
              <HandoffSub agent={agent} onCustom={() => setHandoffAgent(agent)} />
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  keepFocus.current = false;
                  // After the menu has closed, so it doesn't pull focus back from the field.
                  setTimeout(() => setRenaming(true), 50);
                }}
              >
                <Pencil /> Rename
              </DropdownMenuItem>
              {!tile && (
                <DropdownMenuItem
                  shortcut={`${modKey}+\``}
                  onSelect={() => useUi.getState().setWorkspaceOpen(!workspaceOpen)}
                >
                  <SquareTerminal /> {workspaceOpen ? "Hide terminal panel" : "Show terminal panel"}
                  {workspaceRoom === 0 ? " (window is small)" : ""}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => void attempt("Couldn't open the folder", () => api.openPath(agent.cwd))}
              >
                <FolderOpen /> Open folder
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openToolkit(undefined, agent.projectPath)}>
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
                    <span className="ml-auto pl-3 text-xs text-steel tabular">
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
          {ownsPanels && (
            <span
              ref={addRef}
              aria-hidden
              inert
              className="pointer-events-none absolute right-0 top-0 h-px w-px overflow-hidden opacity-0"
            >
              <AddAgents agent={agent} showLabel={false} />
            </span>
          )}
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

/** Header "Review" button: says what it is and how many files changed; icon + count badge when narrow. */
function ReviewPill({
  tier,
  count,
  onClick,
}: {
  tier: "full" | "icons" | "compact";
  count: number;
  onClick: () => void;
}) {
  const files = `${count} file${count === 1 ? "" : "s"}`;
  const label = count > 0 ? `Review ${files}` : "Review changes";
  const tip = count > 0 ? `Review the ${files} this agent changed` : "Review changes (none yet)";
  const full = tier === "full";
  return (
    <Tooltip content={tip}>
      <Button
        size={full ? "md" : tier === "icons" ? "icon" : "icon-sm"}
        variant="secondary"
        onClick={onClick}
        aria-label={label}
        className={cn("relative", full && "gap-1.5 px-2.5")}
      >
        <GitCompare />
        {full && <span>{label}</span>}
        {!full && count > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-micro font-bold leading-none text-accent-fg tabular">
            {count}
          </span>
        )}
      </Button>
    </Tooltip>
  );
}

/** The rate-limit chip when there is no room for words: an icon that says the same on hover and to screen readers. */
function LimitMark({ agent }: { agent: Agent }) {
  const enabled = useApp((s) => s.settings?.resumeAfterLimit ?? true);
  const text = `Rate limited${resumesShort(agent, enabled) ? `. ${resumesShort(agent, enabled)}` : ""}`;
  return (
    <Tooltip content={text}>
      <span role="img" aria-label={text} className="flex h-6 w-5 items-center justify-center text-warn">
        <Gauge className="h-3.5 w-3.5" />
      </span>
    </Tooltip>
  );
}

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-line bg-card/60 px-2 text-xs",
        className,
      )}
    >
      {children}
    </span>
  );
}

function EditableTitle({
  agent,
  editing,
  setEditing,
}: {
  agent: Agent;
  editing: boolean;
  setEditing: (v: boolean) => void;
}) {
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
      inputRef.current?.focus();
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
      className="group relative -ml-1.5 flex h-6 w-[calc(100%+6px)] items-center rounded-md px-1.5 text-left transition-colors hover:bg-raised/60"
    >
      <h1 className="truncate text-[15.5px] font-semibold leading-snug tracking-[-0.015em] text-fg">{agent.title}</h1>
      {/* Floats over the end of the row: the title keeps the room it would have given the icon. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 flex items-center rounded-r-md bg-raised pl-1 pr-1.5 text-steel opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        <Pencil className="h-3.5 w-3.5" />
      </span>
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
            <span className="ml-auto truncate pl-3 text-xs text-steel">{a.name}</span>
          </DropdownMenuItem>
        ))}
        {customs.slice(0, 3).map((c) => (
          <DropdownMenuItem key={c.id} onSelect={() => void quick("custom", CUSTOM_ACCOUNT_ID, c.id)}>
            <ProviderGlyph provider="custom" customAgentId={c.id} size="xs" />
            <span className="truncate">Ask {c.name}</span>
            <span className="ml-auto truncate pl-3 text-xs text-steel">ACP</span>
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
