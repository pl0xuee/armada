import {
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  CalendarClock,
  Download,
  Gauge,
  Repeat,
  ChevronRight,
  PanelLeftClose,
  Pencil,
  Play,
  Power,
  Plus,
  Search,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { m, AnimatePresence } from "motion/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { archiveAgent, exportConversation, renameAgent, resumeAgent, stopAgent } from "@/lib/actions";
import { groupAgents, orderedAgents, type AgentGroupId } from "@/lib/agents";
import { relativeTime, relativeTimeLong } from "@/lib/format";
import { DONE_META, STATUS } from "@/lib/providers";
import { useIsDone } from "@/store/completion";
import type { Account, Agent } from "@/lib/types";
import { basename, cn, modKey } from "@/lib/utils";
import { useIdentity } from "@/hooks/useIdentity";
import { toggleAgentList } from "@/hooks/useAgentListLayout";
import { useNow } from "@/hooks/useNow";
import { useApp } from "@/store/app";
import { usePr } from "@/store/pr";
import { ciSummary, listIndicator } from "@/lib/pr";
import { useUi } from "@/store/ui";
import { ProviderGlyph } from "../ProviderGlyph";
import { useRunningSubagentCount } from "./useSubagents";
import { CiIcon } from "./PrChip";
import { StatusDot } from "../StatusDot";
import { Button } from "../ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../ui/menu";
import { Kbd } from "../ui/kbd";
import { Tooltip } from "../ui/tooltip";

const COLLAPSE_KEY = "armada.collapsedGroups";

function readCollapsed(): Record<AgentGroupId, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (raw) return JSON.parse(raw) as Record<AgentGroupId, boolean>;
  } catch {
    /* ignore */
  }
  return { needs: false, working: false, recent: false, archived: true };
}

export type AgentListVariant = "docked" | "drawer" | "full";

export function AgentList({
  variant = "docked",
  onNavigate,
}: {
  variant?: AgentListVariant;
  /** Called after an agent is opened (closes the drawer on narrow windows). */
  onNavigate?: () => void;
}) {
  const agentsMap = useApp((s) => s.agents);
  const accounts = useApp((s) => s.accounts);
  const selected = useUi((s) => s.selectedAgentId);
  const openNewAgent = useUi((s) => s.openNewAgent);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const searchRef = useRef<HTMLInputElement>(null);
  const now = useNow();

  const agents = useMemo(() => Object.values(agentsMap), [agentsMap]);
  const groups = useMemo(() => groupAgents(agents, query), [agents, query]);
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const total = agents.filter((a) => !a.archived).length;
  const searching = query.trim().length > 0;

  const toggle = (id: AgentGroupId) => {
    const next = { ...collapsed, [id]: !collapsed[id] };
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  // "/" focuses the search when nothing else is focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement === document.body) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ⌘1–9 targets come from the same ordering the shortcut uses (not the visible rows).
  const hotkeys = useMemo(() => {
    const m = new Map<string, number>();
    orderedAgents(agents)
      .slice(0, 9)
      .forEach((a, i) => m.set(a.id, i + 1));
    return m;
  }, [agents]);

  return (
    <aside
      aria-label="Agents"
      className={cn(
        "flex h-full flex-col bg-panel",
        variant === "docked" && "w-[clamp(272px,24vw,304px)] shrink-0 border-r border-line",
        variant === "drawer" && "w-[min(320px,calc(100vw-72px))] border-r border-line-strong",
        variant === "full" && "min-w-0 flex-1",
      )}
    >
      <div className={cn("flex h-full w-full flex-col", variant === "full" && "mx-auto max-w-[760px]")}>
        <div className={cn("flex items-center gap-2 px-3.5 pb-2 pt-3", variant === "full" && "px-4 pb-3 pt-5")}>
          {variant !== "full" && (
            <Tooltip content={variant === "drawer" ? "Close agent list" : "Hide agent list"} shortcut={[modKey, "B"]}>
              <Button
                size="icon-xs"
                variant="ghost"
                className="-ml-1"
                aria-label={variant === "drawer" ? "Close agent list" : "Hide agent list"}
                onClick={toggleAgentList}
              >
                {variant === "drawer" ? <X className="!h-3.5 !w-3.5" /> : <PanelLeftClose className="!h-3.5 !w-3.5" />}
              </Button>
            </Tooltip>
          )}
          <h2 className={cn("font-semibold tracking-tight", variant === "full" ? "text-[18px]" : "text-[13px]")}>
            Agents
          </h2>
          <span className="rounded-md bg-raised px-1.5 text-[11px] font-medium text-steel tabular">{total}</span>
          <Tooltip content="New agent" shortcut={[modKey, "N"]}>
            <Button
              size="sm"
              variant="primary"
              className={cn("ml-auto gap-1 px-2", variant === "full" ? "h-8 px-3" : "h-7")}
              onClick={() => openNewAgent()}
            >
              <Plus className="!h-3.5 !w-3.5" strokeWidth={2.5} />
              {variant === "full" ? "New agent" : "New"}
            </Button>
          </Tooltip>
        </div>
        <div className="px-3 pb-2">
          <div className="group relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-steel" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Escape") {
                  setQuery("");
                  (e.target as HTMLInputElement).blur();
                }
              }}
              placeholder="Filter agents"
              aria-label="Filter agents"
              spellCheck={false}
              className="h-8 w-full rounded-lg border border-line bg-base/50 pl-8 pr-8 text-[12.5px] text-fg placeholder:text-steel transition-colors hover:border-line-strong focus:border-accent/50 focus:outline-none focus:ring-3 focus:ring-accent/10"
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear filter"
                onClick={() => setQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-steel hover:text-fg"
              >
                <X className="h-3 w-3" />
              </button>
            ) : (
              <Kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 opacity-70">/</Kbd>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {groups.map((g) => {
            if (g.agents.length === 0) return null;
            const isCollapsed = collapsed[g.id] && !searching;
            return (
              <div key={g.id} className="mb-1">
                <button
                  type="button"
                  onClick={() => toggle(g.id)}
                  aria-expanded={!isCollapsed}
                  className="group flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-steel transition-colors hover:text-muted"
                >
                  <ChevronRight
                    className={cn("h-3 w-3 transition-transform duration-150", !isCollapsed && "rotate-90")}
                  />
                  <span className={cn(g.id === "needs" && "text-warn/90")}>{g.label}</span>
                  <span className="font-medium tabular text-steel/70">{g.agents.length}</span>
                </button>
                <AnimatePresence initial={false}>
                  {!isCollapsed && (
                    <m.ul
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.12 }}
                      className="space-y-px"
                    >
                      {g.agents.map((a) => {
                        return (
                          <AgentRow
                            key={a.id}
                            agent={a}
                            account={accountMap.get(a.accountId)}
                            selected={a.id === selected}
                            now={now}
                            hotkey={hotkeys.get(a.id) ?? null}
                            onNavigate={onNavigate}
                          />
                        );
                      })}
                    </m.ul>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
          {searching && groups.every((g) => g.agents.length === 0) && (
            <div className="px-4 py-10 text-center text-[12.5px] text-steel">No agents match “{query}”.</div>
          )}
          {!searching && agents.length === 0 && (
            <div className="px-4 py-10 text-center">
              <p className="text-[13px] font-medium">No agents yet</p>
              <p className="mt-1 text-[12px] text-steel">Launch your first one to get started.</p>
              <Button size="sm" variant="primary" className="mt-4" onClick={() => openNewAgent()}>
                <Plus className="!h-3.5 !w-3.5" /> New agent
              </Button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

/** Running sub-agent count. Nothing when there are none. */
function SubagentBadge({ agentId }: { agentId: string }) {
  const n = useRunningSubagentCount(agentId);
  if (n === 0) return null;
  return (
    <Tooltip content={`${n} sub-agent${n === 1 ? "" : "s"} running`} side="right">
      <span
        className="flex shrink-0 items-center gap-0.5 text-[11px] text-accent tabular"
        aria-label={`${n} sub-agent${n === 1 ? "" : "s"} running`}
      >
        <Workflow className="h-3 w-3" />
        {n}
      </span>
    </Tooltip>
  );
}

/** "#12" + CI glyph for agents with an open PR. Nothing otherwise, so most rows stay clean. */
function PrIndicator({ agentId }: { agentId: string }) {
  const pr = usePr((s) => listIndicator(s.byAgent[agentId]));
  if (!pr) return null;
  return (
    <Tooltip content={`PR #${pr.number} · ${ciSummary(pr)}`} side="right">
      <span
        className="flex shrink-0 items-center gap-0.5 text-[11px] tabular"
        aria-label={`Pull request ${pr.number}, ${ciSummary(pr)}`}
      >
        #{pr.number}
        <CiIcon pr={pr} />
      </span>
    </Tooltip>
  );
}

const AgentRow = memo(function AgentRow({
  agent,
  account,
  selected,
  now,
  hotkey,
  onNavigate,
}: {
  agent: Agent;
  account: Account | undefined;
  selected: boolean;
  now: number;
  hotkey: number | null;
  onNavigate?: () => void;
}) {
  const openAgent = useUi((s) => s.openAgent);
  const setHandoffAgent = useUi((s) => s.setHandoffAgent);
  const setDeleteAgent = useUi((s) => s.setDeleteAgent);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(agent.title);
  const done = useIsDone(agent);
  const status = done ? DONE_META : STATUS[agent.status];
  const identity = useIdentity(agent.provider, agent.customAgentId);
  const resumable = agent.status === "interrupted" || agent.status === "stopped";
  const live = agent.status === "working" || agent.status === "needs_permission" || agent.status === "starting";

  const inputRef = useRef<HTMLInputElement>(null);
  /** Always start from the current title (it may have changed since the row mounted). */
  // Ends exactly once: Enter commits, Esc cancels, blur commits only if neither happened.
  const settled = useRef(false);
  const startRename = () => {
    settled.current = false;
    setTitle(agent.title);
    setRenaming(true);
  };
  useEffect(() => {
    if (!renaming) return;
    // After the context menu closes and returns focus, take it back.
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, [renaming]);

  const cancelRename = () => {
    settled.current = true;
    setTitle(agent.title);
    setRenaming(false);
  };

  const commitRename = async () => {
    if (settled.current) return;
    settled.current = true;
    setRenaming(false);
    const t = title.trim();
    if (t && t !== agent.title) await renameAgent(agent, t);
    else setTitle(agent.title);
  };

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            aria-current={selected ? "true" : undefined}
            aria-label={`${agent.title}, ${status.label}`}
            onClick={() => {
              if (renaming) return;
              openAgent(agent.id);
              onNavigate?.();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !renaming) {
                openAgent(agent.id);
                onNavigate?.();
              }
              if (e.key === "F2") startRename();
            }}
            className={cn(
              "group relative flex gap-2.5 rounded-xl px-2.5 py-2 outline-none transition-colors duration-100",
              selected ? "bg-gunmetal/70 shadow-[inset_0_0_0_1px_var(--border-strong)] edge" : "hover:bg-raised/60",
              "focus-visible:shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--accent)_70%,transparent)]",
            )}
          >
            {selected && (
              <m.span
                layoutId="agent-row-active"
                transition={{ type: "spring", stiffness: 600, damping: 42 }}
                className="absolute -left-2 top-3 h-6 w-[3px] rounded-r-full bg-accent shadow-[0_0_8px_var(--accent)]"
              />
            )}
            <div className="relative mt-0.5 self-start">
              {live && (
                <span
                  className="pointer-events-none absolute inset-0 rounded-[8px] animate-breathe"
                  style={{ boxShadow: `0 0 12px 1px color-mix(in srgb, ${status.colorVar} 45%, transparent)` }}
                  aria-hidden
                />
              )}
              <ProviderGlyph provider={agent.provider} customAgentId={agent.customAgentId} size="md" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                {renaming ? (
                  <input
                    ref={inputRef}
                    value={title}
                    aria-label="Agent title"
                    onChange={(e) => setTitle(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => void commitRename()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void commitRename();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelRename();
                      }
                    }}
                    className="h-5 min-w-0 flex-1 rounded border border-accent/50 bg-base px-1 text-[13px] focus:outline-none"
                  />
                ) : (
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[13px]",
                      agent.unread ? "font-semibold text-fg" : "font-medium text-fg/90",
                    )}
                  >
                    {agent.title}
                  </span>
                )}
                {agent.unread && !selected && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent shadow-[0_0_6px_var(--accent)]"
                    aria-label="Unread"
                  />
                )}
                <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-steel">
                  {hotkey !== null && (
                    <span aria-hidden className="hidden text-[10px] text-steel/70 group-hover:inline">
                      {modKey}
                      {hotkey}
                    </span>
                  )}
                  <span className="sr-only">Last active </span>
                  <Tooltip
                    content={`${relativeTimeLong(agent.lastActivityAt, now)} · ${new Date(agent.lastActivityAt).toLocaleString()}`}
                    side="right"
                  >
                    <time dateTime={new Date(agent.lastActivityAt).toISOString()} className="tabular">
                      {relativeTime(agent.lastActivityAt, now)}
                    </time>
                  </Tooltip>
                </span>
              </div>
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[11.5px] text-steel">
                <StatusDot status={agent.status} size={6} done={done} />
                <span
                  className="shrink-0"
                  style={{
                    color:
                      !done && (agent.status === "idle" || agent.status === "stopped") ? undefined : status.colorVar,
                  }}
                >
                  {status.label}
                </span>
                {agent.rateLimited && (
                  <Tooltip content="Hit its usage limit" side="right">
                    <span className="flex items-center text-warn" aria-label="Usage limit reached">
                      <Gauge className="h-3 w-3" />
                    </span>
                  </Tooltip>
                )}
                {agent.scheduleId && (
                  <Tooltip content="Started by a schedule" side="right">
                    <span className="flex items-center text-steel" aria-label="Scheduled">
                      <CalendarClock className="h-3 w-3" />
                    </span>
                  </Tooltip>
                )}
                <SubagentBadge agentId={agent.id} />
                <PrIndicator agentId={agent.id} />
                <span className="text-line-strong">·</span>
                <span className="truncate">
                  {agent.provider === "custom" ? identity.name : (account?.name ?? "—")} · {basename(agent.projectPath)}
                </span>
              </div>
              {agent.lastMessage && (
                <p className="mt-1 line-clamp-1 text-[12px] leading-snug text-muted/90">{agent.lastMessage}</p>
              )}
              {resumable && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void resumeAgent(agent);
                  }}
                  className={cn(
                    "mt-1.5 inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11.5px] font-medium transition-colors",
                    agent.status === "interrupted"
                      ? "border-violet/40 bg-violet/10 text-violet hover:bg-violet/20"
                      : "border-line-strong bg-raised text-muted hover:text-fg",
                  )}
                >
                  <Play className="h-3 w-3" /> Resume
                </button>
              )}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={(e) => renaming && e.preventDefault()}>
          <ContextMenuItem onSelect={startRename} shortcut="F2">
            <Pencil /> Rename
          </ContextMenuItem>
          {resumable ? (
            <ContextMenuItem onSelect={() => void resumeAgent(agent)}>
              <Play /> Resume
            </ContextMenuItem>
          ) : (
            <ContextMenuItem disabled={!agent.running} onSelect={() => void stopAgent(agent)}>
              <Power /> Shut down
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => setHandoffAgent(agent)}>
            <ArrowRightLeft /> Hand off to…
          </ContextMenuItem>
          {agent.provider !== "custom" && (
            <ContextMenuItem onSelect={() => useUi.getState().setMoveAgent(agent)}>
              <Repeat /> Move to another account…
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => void exportConversation(agent)}>
            <Download /> Export conversation…
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void archiveAgent(agent, !agent.archived)}>
            {agent.archived ? <ArchiveRestore /> : <Archive />}
            {agent.archived ? "Unarchive" : "Archive"}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem danger onSelect={() => setDeleteAgent(agent)}>
            <Trash2 /> Delete…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
});
