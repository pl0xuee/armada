import {
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  CalendarClock,
  CircleDot,
  Download,
  Gauge,
  GitFork,
  Repeat,
  ChevronRight,
  FolderOpen,
  LayoutGrid,
  PanelLeftClose,
  Pencil,
  Play,
  Power,
  Plus,
  RefreshCw,
  Rows3,
  Search,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { m, AnimatePresence } from "motion/react";
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { archiveAgent, exportConversation, refreshProjects, renameAgent, resumeAgent, stopAgent } from "@/lib/actions";
import { ARCHIVED_KEY, groupByProject, orderedAgents, projectKey } from "@/lib/agents";
import { MAX_TILES, nestHelpers, syncPresentation } from "@/lib/helpers";
import { relativeTime, relativeTimeLong } from "@/lib/format";
import { useBackgroundIds, useStatusView } from "@/store/background";
import type { Account, Agent } from "@/lib/types";
import { basename, cn, modKey } from "@/lib/utils";
import { useIdentity } from "@/hooks/useIdentity";
import { toggleAgentList } from "@/hooks/useAgentListLayout";
import { useNow } from "@/hooks/useNow";
import { useApp } from "@/store/app";
import { usePr } from "@/store/pr";
import { ciSummary, listIndicator } from "@/lib/pr";
import { useUi } from "@/store/ui";
import { useVa } from "@/store/voiceAssistant";
import { isLive } from "@/lib/voiceAssistant";
import { ProviderGlyph } from "../ProviderGlyph";
import { useRunningSubagentCount } from "./useSubagents";
import { useAfterPaint } from "@/hooks/useAfterPaint";
import { CiIcon } from "./PrChip";
import { ResumesAt } from "./ResumesAt";
import { StatusDot } from "../StatusDot";
import { Button } from "../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuCheckItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/menu";
import { Kbd } from "../ui/kbd";
import { Tooltip } from "../ui/tooltip";

const COLLAPSE_KEY = "armada.collapsedProjects";

/** Which projects are folded, by folder path (archived agents are folded unless opened). */
function readCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (raw) return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    /* ignore */
  }
  return { [ARCHIVED_KEY]: true };
}

const DENSITY_KEY = "armada.sidebarDensity";

/** Comfortable also gives the open and waiting rows a preview line; compact never does. */
type Density = "comfortable" | "compact";

function readDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

const NO_PROJECTS: never[] = [];

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
  const openAgents = useUi((s) => s.openAgents);
  const openNewAgent = useUi((s) => s.openNewAgent);
  const openIssues = useUi((s) => s.openIssues);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [density, setDensity] = useState(readDensity);
  const [refreshing, setRefreshing] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const now = useNow();
  // Rows join the second frame at boot (header and filter paint first); later mounts are immediate.
  const afterPaint = useAfterPaint();
  const rowsReady = afterPaint || variant !== "docked";

  const agents = useMemo(() => Object.values(agentsMap), [agentsMap]);
  // Agents whose turn ended but whose workflow / background agents still run count as working.
  const background = useBackgroundIds();
  // Helpers nest under their main agent, except while filtering (then every match is its own row).
  const searchingNow = query.trim().length > 0;
  const nesting = useMemo(() => (searchingNow ? null : nestHelpers(agents)), [agents, searchingNow]);
  const { projects, archived } = useMemo(
    () => groupByProject(nesting ? nesting.roots : agents, query, background),
    [nesting, agents, query, background],
  );
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  // Name the account on a row only for providers that have more than one, so it tells agents apart.
  const multiAccount = useMemo(() => {
    const seen = new Map<string, number>();
    for (const a of accounts) seen.set(a.provider, (seen.get(a.provider) ?? 0) + 1);
    return new Set([...seen].filter(([, n]) => n > 1).map(([provider]) => provider));
  }, [accounts]);
  const searching = query.trim().length > 0;
  // Counts every project that has agents, not only the ones matching the filter.
  const total = useMemo(
    () => new Set(agents.filter((a) => !a.archived).map((a) => projectKey(a.projectPath))).size,
    [agents],
  );

  const toggle = (id: string) => {
    const next = { ...collapsed, [id]: !collapsed[id] };
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const chooseDensity = (d: Density) => {
    setDensity(d);
    try {
      localStorage.setItem(DENSITY_KEY, d);
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
  // "Agent 2" to the voice assistant is the 2nd agent in this same order (it lists the first 25). Shown only
  // while it is on. It numbers projects from its own list (recent and found folders), which this list isn't.
  const vaOn = useVa((s) => isLive(s));
  const voiceNumbers = useMemo(() => {
    const m = new Map<string, number>();
    if (vaOn)
      orderedAgents(agents)
        .slice(0, 25)
        .forEach((a, i) => m.set(a.id, i + 1));
    return m;
  }, [agents, vaOn]);

  return (
    <aside
      aria-label="Projects"
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
            <Tooltip
              content={variant === "drawer" ? "Close project list" : "Hide project list"}
              shortcut={[modKey, "B"]}
            >
              <Button
                size="icon-xs"
                variant="ghost"
                className="-ml-1"
                aria-label={variant === "drawer" ? "Close project list" : "Hide project list"}
                onClick={toggleAgentList}
              >
                {variant === "drawer" ? <X className="!h-3.5 !w-3.5" /> : <PanelLeftClose className="!h-3.5 !w-3.5" />}
              </Button>
            </Tooltip>
          )}
          <h2 className={cn("font-semibold tracking-tight", variant === "full" ? "text-[18px]" : "text-[13px]")}>
            Projects
          </h2>
          <span className="rounded-md bg-raised px-1.5 text-[11px] font-medium text-steel tabular">{total}</span>
          <Tooltip content="Refresh: find projects whose folder was renamed or moved">
            <Button
              size="icon-xs"
              variant="ghost"
              className="ml-auto"
              aria-label="Refresh projects"
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                await refreshProjects();
                setRefreshing(false);
              }}
            >
              <RefreshCw className={cn("!h-3.5 !w-3.5", refreshing && "animate-spin")} />
            </Button>
          </Tooltip>
          <DropdownMenu>
            <Tooltip content="Row density">
              <DropdownMenuTrigger asChild>
                <Button size="icon-xs" variant="ghost" aria-label="Row density">
                  <Rows3 className="!h-3.5 !w-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-[170px]">
              <DropdownMenuLabel>Row density</DropdownMenuLabel>
              <DropdownMenuCheckItem checked={density === "comfortable"} onSelect={() => chooseDensity("comfortable")}>
                Comfortable
              </DropdownMenuCheckItem>
              <DropdownMenuCheckItem checked={density === "compact"} onSelect={() => chooseDensity("compact")}>
                Compact
              </DropdownMenuCheckItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* The full list sits under the home composer, which already starts agents. */}
          {variant !== "full" && (
            <Tooltip content="New agent" shortcut={[modKey, "N"]}>
              <Button size="sm" variant="primary" className="h-7 gap-1 px-2" onClick={() => openNewAgent()}>
                <Plus className="!h-3.5 !w-3.5" strokeWidth={2.5} />
                New
              </Button>
            </Tooltip>
          )}
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
              placeholder="Filter projects"
              aria-label="Filter projects"
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
              <Kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">/</Kbd>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {(rowsReady ? projects : NO_PROJECTS).map((p) => {
            const isCollapsed = collapsed[p.path] && !searching;
            // The open agent lives in this project (as one of its agents or a helper under one).
            const holdsOpen = p.agents.some(
              (a) => a.id === selected || nesting?.children.get(a.id)?.some((h) => h.id === selected),
            );
            const together = p.agents.length >= 2;
            return (
              // One flat section per project: a quiet header, then its agents. No boxes, so the list reads as one column.
              <div key={p.path} className="mb-3">
                <div className="group/project @container/proj relative flex h-8 items-center rounded-lg pr-1 transition-colors hover:bg-raised/60">
                  <button
                    type="button"
                    onClick={() => toggle(p.path)}
                    aria-expanded={!isCollapsed}
                    title={p.path}
                    className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md pl-1 pr-1 text-[12.5px] font-semibold tracking-tight text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <ChevronRight
                      className={cn(
                        "h-3 w-3 shrink-0 text-muted transition-transform duration-150",
                        !isCollapsed && "rotate-90",
                      )}
                    />
                    <FolderOpen className={cn("h-4 w-4 shrink-0", holdsOpen ? "text-accent" : "text-muted")} />
                    <span className="truncate">{p.name}</span>
                    <span className="shrink-0 text-[11.5px] font-medium tabular text-steel">{p.agents.length}</span>
                    {p.needs > 0 && (
                      <span
                        className="flex shrink-0 items-center gap-1 rounded-full bg-warn/20 px-1.5 py-px text-[11px] font-semibold text-warn ring-1 ring-warn/40 tabular"
                        title={`${p.needs} need${p.needs === 1 ? "s" : ""} you`}
                      >
                        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-warn" />
                        {p.needs}
                        <span className="hidden @[286px]/proj:inline">need{p.needs === 1 ? "s" : ""} you</span>
                        <span className="sr-only @[286px]/proj:hidden">need{p.needs === 1 ? "s" : ""} you</span>
                      </span>
                    )}
                    {p.needs === 0 && p.working > 0 && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent animate-breathe"
                        aria-label={`${p.working} working`}
                      />
                    )}
                  </button>
                  {/* Rests hidden so the name keeps its room; fades in over the header's right edge. */}
                  <div className="absolute inset-y-0 right-1 flex items-center gap-1 rounded-r-lg bg-gradient-to-l from-raised from-70% to-transparent pl-4 pointer-events-none opacity-0 transition-opacity duration-150 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/project:pointer-events-auto group-hover/project:opacity-100">
                    {together && (
                      <Tooltip content="Show these together">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="shrink-0 text-muted hover:text-accent"
                          aria-label={`Show ${p.name}'s agents together`}
                          onClick={() => {
                            const ids = [...p.agents]
                              .sort((x, y) => x.createdAt - y.createdAt || x.id.localeCompare(y.id))
                              .slice(0, MAX_TILES)
                              .map((a) => a.id);
                            openAgents(ids, selected && ids.includes(selected) ? selected : ids[0]);
                            onNavigate?.();
                          }}
                        >
                          <LayoutGrid className="!h-3.5 !w-3.5" />
                        </Button>
                      </Tooltip>
                    )}
                    <Tooltip content="GitHub issues">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="shrink-0 text-muted hover:text-accent"
                        aria-label={`GitHub issues of ${p.name}`}
                        onClick={() => openIssues(p.path)}
                      >
                        <CircleDot className="!h-3.5 !w-3.5" />
                      </Button>
                    </Tooltip>
                    <Tooltip content={`New agent in ${p.name}`}>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="shrink-0 border border-line-strong/70 text-muted hover:border-accent/50 hover:text-accent"
                        aria-label={`New agent in ${p.name}`}
                        onClick={() => openNewAgent({ projectPath: p.path })}
                      >
                        <Plus className="!h-3.5 !w-3.5" />
                      </Button>
                    </Tooltip>
                  </div>
                </div>
                <AnimatePresence initial={false}>
                  {!isCollapsed && (
                    <m.ul
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.12 }}
                      className="space-y-0.5"
                    >
                      {p.agents.map((a) => (
                        <Fragment key={a.id}>
                          <AgentRow
                            agent={a}
                            account={accountMap.get(a.accountId)}
                            showAccount={a.provider === "custom" || multiAccount.has(a.provider)}
                            selected={a.id === selected}
                            now={now}
                            hotkey={hotkeys.get(a.id) ?? null}
                            voiceNumber={voiceNumbers.get(a.id) ?? null}
                            density={density}
                            onNavigate={onNavigate}
                          />
                          {nesting?.children.get(a.id)?.map((h) => (
                            <AgentRow
                              key={h.id}
                              nested
                              agent={h}
                              account={accountMap.get(h.accountId)}
                              showAccount={h.provider === "custom" || multiAccount.has(h.provider)}
                              selected={h.id === selected}
                              now={now}
                              hotkey={hotkeys.get(h.id) ?? null}
                              voiceNumber={voiceNumbers.get(h.id) ?? null}
                              density={density}
                              onNavigate={onNavigate}
                            />
                          ))}
                        </Fragment>
                      ))}
                    </m.ul>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
          {rowsReady && archived.length > 0 && (
            <div className="mb-1">
              <button
                type="button"
                onClick={() => toggle(ARCHIVED_KEY)}
                aria-expanded={!collapsed[ARCHIVED_KEY] || searching}
                className="flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-steel transition-colors hover:text-muted"
              >
                <ChevronRight
                  className={cn(
                    "h-3 w-3 transition-transform duration-150",
                    (!collapsed[ARCHIVED_KEY] || searching) && "rotate-90",
                  )}
                />
                Archived
                <span className="font-medium tabular text-steel">{archived.length}</span>
              </button>
              {(!collapsed[ARCHIVED_KEY] || searching) && (
                <ul className="space-y-px">
                  {archived.map((a) => (
                    <AgentRow
                      key={a.id}
                      agent={a}
                      account={accountMap.get(a.accountId)}
                      showAccount={a.provider === "custom" || multiAccount.has(a.provider)}
                      selected={a.id === selected}
                      now={now}
                      hotkey={null}
                      density={density}
                      showProject
                      onNavigate={onNavigate}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
          {searching && projects.length === 0 && archived.length === 0 && (
            <div className="px-4 py-10 text-center text-[12.5px] text-steel">
              No projects or agents match “{query}”.
              <div className="mt-3">
                <Button size="sm" variant="secondary" onClick={() => setQuery("")}>
                  Clear filter
                </Button>
              </div>
            </div>
          )}
          {!searching && agents.length === 0 && (
            <div className="px-4 py-10 text-center">
              <p className="text-[13px] font-medium">No projects yet</p>
              <p className="mt-1 text-[12px] text-steel">Launch an agent in a folder to get started.</p>
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

/** Tiny sync state on a helper's row: only the states worth a glance. */
function SyncHint({ sync }: { sync: NonNullable<Agent["helperSync"]> }) {
  if (sync.state === "inSync") return null;
  const v = syncPresentation(sync, "the main agent");
  const label = sync.state === "conflict" ? "Conflict" : sync.state === "merging" ? "Merging" : "Syncing";
  return (
    <Tooltip content={sync.detail ?? v.label} side="right">
      <span className={cn("shrink-0 text-[11px]", v.tone === "warn" ? "text-warn" : "text-steel")}>{label}</span>
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
  voiceNumber = null,
  density,
  onNavigate,
  nested = false,
  showProject = false,
  showAccount = true,
}: {
  /** False when this provider has a single account, so naming it on every row is noise. */
  showAccount?: boolean;
  nested?: boolean;
  /** Archived rows sit outside a project card, so they name their project. */
  showProject?: boolean;
  density: Density;
  agent: Agent;
  account: Account | undefined;
  selected: boolean;
  now: number;
  hotkey: number | null;
  /** Its place in the voice assistant's numbering; only while the assistant is on. */
  voiceNumber?: number | null;
  onNavigate?: () => void;
}) {
  const openAgent = useUi((s) => s.openAgent);
  const setHandoffAgent = useUi((s) => s.setHandoffAgent);
  const setDeleteAgent = useUi((s) => s.setDeleteAgent);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(agent.title);
  const view = useStatusView(agent);
  const { done, meta: status } = view;
  const identity = useIdentity(agent.provider, agent.customAgentId);
  const resumable = agent.status === "interrupted" || agent.status === "stopped";
  const compact = density === "compact";

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

  // Opened from the palette, Mission Control or a notification: bring its row into view so the list shows where you are.
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // The row opens the agent. Resume is a button of its own beside it, not inside it (a button can't hold a
  // button), so the opener is one element and the row around it also takes the click on its padding.
  const open = () => {
    openAgent(agent.id);
    onNavigate?.();
  };
  // While the title is being edited the opener holds a text field: it is no button then.
  const openerProps = renaming
    ? {}
    : {
        role: "button",
        tabIndex: 0,
        "aria-current": selected ? ("true" as const) : undefined,
        "aria-label": `${agent.title}, ${status.label}`,
      };

  return (
    <li className={nested ? "relative ml-[22px] border-l border-line pl-1.5" : undefined}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={rowRef}
            onClick={() => {
              if (!renaming) open();
            }}
            className={cn(
              "group relative rounded-lg transition-colors duration-100",
              selected ? "bg-accent/[0.11]" : "hover:bg-raised/60",
              "has-[[role=button]:focus-visible]:shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--accent)_70%,transparent)]",
            )}
          >
            {selected && (
              <m.span
                layoutId="agent-row-active"
                transition={{ type: "spring", stiffness: 600, damping: 42 }}
                className="absolute -left-1 top-2.5 h-[22px] w-[3px] rounded-r-full bg-accent"
              />
            )}
            <div
              {...openerProps}
              onKeyDown={(e) => {
                // Keys pressed on something inside the row (the title field) are theirs, not the row's.
                if (e.target !== e.currentTarget) return;
                if ((e.key === "Enter" || e.key === " ") && !renaming) {
                  e.preventDefault();
                  open();
                }
                if (e.key === "F2") startRename();
              }}
              className={cn(
                "flex gap-2.5 rounded-lg px-2 outline-none",
                // The Resume button below takes the bottom padding of a row that has one.
                resumable ? (compact ? "pt-1.5" : "pt-2") : compact ? "py-1.5" : "py-2",
              )}
            >
              <div className="relative mt-0.5 self-start">
                <ProviderGlyph
                  provider={agent.provider}
                  customAgentId={agent.customAgentId}
                  size={nested ? "sm" : "md"}
                />
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
                  {agent.parentId && (
                    <Tooltip content="Helper agent" side="right">
                      <span className="flex shrink-0 items-center text-accent" aria-label="Helper agent">
                        <GitFork className="h-3 w-3" />
                      </span>
                    </Tooltip>
                  )}
                  {agent.unread && !selected && (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent shadow-[0_0_6px_var(--accent)]"
                      aria-label="Unread"
                    />
                  )}
                  <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-steel">
                    {hotkey !== null && (
                      <span aria-hidden className="hidden text-[11px] text-steel group-hover:inline">
                        {modKey}
                        {hotkey}
                      </span>
                    )}
                    {voiceNumber !== null && (
                      <Tooltip content={`Say "agent ${voiceNumber}" to the voice assistant`} side="right">
                        <span className="tabular rounded border border-line px-1 text-[10px] leading-[14px] text-steel/80">
                          {voiceNumber}
                        </span>
                      </Tooltip>
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
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11.5px] text-steel">
                  <StatusDot status={view.dot} size={6} done={done} />
                  {/* May shrink (and end in …) when the label is long, e.g. "1 background agent may be running". */}
                  <span
                    className="min-w-0 truncate"
                    title={view.detail ?? undefined}
                    style={{
                      color:
                        !done && !view.background && (agent.status === "idle" || agent.status === "stopped")
                          ? undefined
                          : status.colorVar,
                    }}
                  >
                    {status.label}
                  </span>
                  {agent.rateLimited && (
                    <Tooltip content="Hit its rate limit" side="right">
                      <span className="flex min-w-0 items-center gap-1 text-warn" aria-label="Rate limit reached">
                        <Gauge className="h-3 w-3 shrink-0" />
                        <span className="truncate text-[10.5px]">
                          <ResumesAt agent={agent} />
                        </span>
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
                  {agent.helperSync && <SyncHint sync={agent.helperSync} />}
                  <SubagentBadge agentId={agent.id} />
                  <PrIndicator agentId={agent.id} />
                  {(showAccount || showProject) && (
                    <>
                      <span className="text-line-strong">·</span>
                      <span className="truncate">
                        {showAccount && (agent.provider === "custom" ? identity.name : (account?.name ?? "—"))}
                        {showAccount && showProject && " · "}
                        {showProject && basename(agent.projectPath)}
                      </span>
                    </>
                  )}
                </div>
                {agent.lastMessage &&
                  !nested &&
                  density === "comfortable" &&
                  (selected || agent.status === "needs_permission") && (
                    <p className="mt-1 line-clamp-1 text-[12px] leading-snug text-muted">{agent.lastMessage}</p>
                  )}
              </div>
            </div>
            {resumable && (
              // Lined up with the text above (row padding + glyph + gap).
              <div className={cn("pt-1.5", compact ? "pb-1.5" : "pb-2", nested ? "pl-[38px]" : "pl-[44px]")}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void resumeAgent(agent);
                  }}
                  className={cn(
                    "inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11.5px] font-medium transition-colors",
                    agent.status === "interrupted"
                      ? "border-violet/40 bg-violet/10 text-violet hover:bg-violet/20"
                      : "border-line-strong bg-raised text-muted hover:text-fg",
                  )}
                >
                  <Play className="h-3 w-3" /> Resume
                </button>
              </div>
            )}
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
