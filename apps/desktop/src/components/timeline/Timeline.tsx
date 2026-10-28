import { ArrowDown } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Agent, TimelineItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useIdentity } from "@/hooks/useIdentity";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { Spinner } from "../ui/misc";
import { Skeleton } from "../ui/skeleton";
import { AgentMessage, NoticeBanner, PermissionCard, PlanCard, ThoughtBlock, ToolCallCard, UserBubble } from "./items";
import { ActivityGroup } from "./ActivityGroup";
import { groupActivity } from "./activityGroups";
import { SubagentCard } from "./SubagentCard";
import { useRunningSubagentCount, useSubagentRuns } from "../agent/useSubagents";
import { useHeld, WAITING_HOLD_MS } from "@/hooks/useHeld";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { shouldShowThinking, turnEndOf, turnStart, waitingStatus } from "./thinking";
import { TurnEndLine } from "./TurnEndLine";
import { TurnSummaryCard, TurnSummaryLine } from "./TurnSummaryCard";
import { latestPending, usePermissionKeys } from "./usePermissionKeys";

/** Within this distance of the bottom counts as "following" the stream. */
const STICK_THRESHOLD = 24;
/** Page older items in when scrolled this close to the top. */
const LOAD_OLDER_PX = 600;

/** Rough height by kind, refined by measurement once a row renders. */
function estimateSize(it: TimelineItem | undefined): number {
  if (!it) return 60;
  switch (it.kind) {
    case "user_message":
      return 72 + Math.min(240, Math.floor(it.text.length / 90) * 22);
    case "agent_message":
      return 60 + Math.min(900, Math.floor(it.text.length / 80) * 24);
    case "thought":
      return 34;
    case "tool_call":
      return it.subagent ? 150 : it.images?.length ? 380 : 48;
    case "permission":
      return it.resolution === null ? 220 : 48;
    case "plan":
      return 60 + it.entries.length * 24;
    case "notice":
      return 46;
    case "turn_summary":
      return 190;
    default:
      return 60;
  }
}

export function Timeline({
  agent,
  items,
  loading,
  footer,
}: {
  agent: Agent;
  items: TimelineItem[] | undefined;
  loading: boolean;
  footer?: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  const stick = useRef(true);
  const lastTop = useRef(0);
  const lastCount = useRef(0);
  const lastTotal = useRef(0);
  const hasOlder = useApp((s) => s.hasOlder[agent.id] ?? false);
  const olderLoading = useApp((s) => s.olderLoading[agent.id] ?? false);

  // Only re-render rows when fields they actually use change (not on every cost/token bump).
  const stableAgent = useStableAgent(agent);
  const list = items ?? NO_ITEMS;
  // The view (which items are top-level rows, sub-agent nesting) only depends on structure,
  // so it's recomputed when items are added/removed, not on every streamed delta.
  // Attribution counts too: the adapter often streams a sub-agent's call before it knows the
  // parent, then names it in a later update; the call must move into its card right away.
  let attributed = 0;
  for (const it of list) if (it.kind === "tool_call" && it.parentToolCallId) attributed++;
  // Only waiting on sub-agents: stray calls fold into one quiet row under a fixed waiting line.
  // Not while an approval is pending: the approval card is the call to action then.
  // Sticky: the count can dip to 0 for a moment between a background sub-agent's turns; the line
  // stays for WAITING_HOLD_MS after the last counted one, and shows while the agent itself is idle.
  const runningSubagents = useHeld(useRunningSubagentCount(agent.id), 0, WAITING_HOLD_MS);
  const waiting = runningSubagents > 0 && waitingStatus(agent.status);
  const bgRunningIds = useBackgroundRunning(agent.id);
  const structureKey = `${list.length}:${list[0]?.id ?? ""}:${list[list.length - 1]?.id ?? ""}:${attributed}:${waiting}`;
  // Keyed on structure on purpose: it reads the current list, but deltas never change the structure.
  const view = useMemo(() => buildView(list, waiting), [structureKey]);
  const rows = view.top;
  const childrenOf = useResolvedLists(view.children, list, isToolItem);
  const groupItems = useResolvedLists(view.groups, list);

  // Expanded activity groups, keyed by group id (kept here so it survives row virtualization).
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  useLayoutEffect(() => setOpenGroups(new Set()), [agent.id]);
  const toggleGroup = useCallback((id: string) => {
    setOpenGroups((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });
  }, []);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const it = list[rows[i]];
      const g = it && groupItems.get(it.id);
      if (g) return openGroups.has(it.id) ? 60 + g.length * 48 : 48;
      return estimateSize(it);
    },
    getItemKey: (i) => list[rows[i]]?.id ?? i,
    overscan: 6,
    paddingStart: 16,
    paddingEnd: 8,
    // Stick to the bottom while content streams in; otherwise flag new activity.
    onChange: (inst) => {
      const total = inst.getTotalSize();
      if (total === lastTotal.current) return;
      const grew = total > lastTotal.current;
      lastTotal.current = total;
      const el = scrollRef.current;
      if (!el) return;
      if (stick.current) el.scrollTop = el.scrollHeight;
      else if (grew) setHasNew(true);
    },
  });

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    // A second pass after measurement settles.
    requestAnimationFrame(() => {
      if (scrollRef.current && stick.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  }, []);

  // Reset when switching agents.
  useLayoutEffect(() => {
    stick.current = true;
    setAtBottom(true);
    setHasNew(false);
    lastCount.current = 0;
    lastTotal.current = 0;
    scrollToBottom();
  }, [agent.id, scrollToBottom]);

  useLayoutEffect(() => {
    const n = rows.length;
    if (n !== lastCount.current) {
      if (stick.current) scrollToBottom();
      else if (n > lastCount.current) setHasNew(true);
      lastCount.current = n;
    }
  }, [rows.length, scrollToBottom]);

  // Scroll to an item another part of the UI asked for (a sub-agent's card), once its row exists.
  const revealTarget = useUi((s) => (s.revealTarget?.agentId === agent.id ? s.revealTarget : null));
  const [flashId, setFlashId] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!revealTarget || (loading && !items)) return;
    const idxOf = new Map<string, number>();
    list.forEach((it, i) => idxOf.set(it.id, i));
    let at = idxOf.get(revealTarget.itemId);
    // Climb out of nested sub-agents to the top-level card.
    for (let guard = 0; at !== undefined && guard < 8; guard++) {
      const it = list[at];
      const parent =
        it.kind === "tool_call" && it.parentToolCallId ? view.parentIdx.get(it.parentToolCallId) : undefined;
      if (parent === undefined) break;
      at = parent;
    }
    const row = at === undefined ? -1 : rows.indexOf(at);
    useUi.getState().clearRevealTarget();
    if (row < 0) return;
    stick.current = false;
    setAtBottom(false);
    virtualizer.scrollToIndex(row, { align: "center" });
    setFlashId(list[at as number].id);
    // Measurement can shift rows after the first jump; settle on the target again.
    requestAnimationFrame(() => virtualizer.scrollToIndex(row, { align: "center" }));
  }, [revealTarget, rows, list, items, loading, view, virtualizer]);
  useEffect(() => {
    if (!flashId) return;
    const t = setTimeout(() => setFlashId(null), 1600);
    return () => clearTimeout(t);
  }, [flashId]);

  // Paging up: remember the first visible row and keep it in place once older items land.
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const requestOlder = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !hasOlder || olderLoading) return;
    const first = virtualizer.getVirtualItems().find((v) => v.end > el.scrollTop);
    const id = first ? list[rows[first.index]]?.id : undefined;
    if (id && first) anchor.current = { id, offset: first.start - el.scrollTop };
    void useApp.getState().loadOlder(agent.id);
  }, [agent.id, hasOlder, olderLoading, list, rows, virtualizer]);

  useLayoutEffect(() => {
    const a = anchor.current;
    const el = scrollRef.current;
    if (!a || !el) return;
    const idx = rows.findIndex((r) => list[r]?.id === a.id);
    if (idx < 0) return;
    anchor.current = null;
    const [offset] = virtualizer.getOffsetForIndex(idx, "start") ?? [0];
    el.scrollTop = Math.max(0, offset - a.offset);
    // Runs when older items were prepended (structure changed).
  }, [structureKey]);

  // An older-page load that finishes without prepending (empty page or error) leaves a stale anchor.
  const wasLoadingOlder = useRef(false);
  useEffect(() => {
    if (wasLoadingOlder.current && !olderLoading) {
      // Let the prepend's layout effect run first (it consumes the anchor); otherwise drop it.
      const t = setTimeout(() => (anchor.current = null), 0);
      wasLoadingOlder.current = olderLoading;
      return () => clearTimeout(t);
    }
    wasLoadingOlder.current = olderLoading;
  }, [olderLoading]);

  // Scroll-ups only unstick when the user caused them (the virtualizer also nudges scrollTop
  // when rows measure smaller than estimated; that must not stop following the stream).
  const userIntentAt = useRef(0);
  const markIntent = () => {
    userIntentAt.current = performance.now();
  };
  const onKeyDownScroll = (e: React.KeyboardEvent) => {
    if (["ArrowUp", "PageUp", "Home", "ArrowDown", "PageDown", "End", " "].includes(e.key)) markIntent();
  };
  const onWheel = (e: React.WheelEvent) => {
    markIntent();
    if (e.deltaY < 0) {
      stick.current = false;
      setAtBottom(false);
    }
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    // A user scroll up stops following, even within the threshold.
    const byUser = performance.now() - userIntentAt.current < 400;
    if (!byUser && stick.current && !bottom) {
      // Layout shifted under us while following: stay pinned.
      el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
      return;
    }
    const movedUp = byUser && el.scrollTop < lastTop.current - 2;
    lastTop.current = el.scrollTop;
    stick.current = bottom && !movedUp;
    if (stick.current !== atBottom) setAtBottom(stick.current);
    if (stick.current) setHasNew(false);
    if (el.scrollTop < LOAD_OLDER_PX) requestOlder();
  };

  const live = agent.status === "working" || agent.status === "starting";
  const lastId = list[list.length - 1]?.id;
  const lastPrompt = view.lastPromptIdx !== null ? (list[view.lastPromptIdx] ?? null) : null;

  // "Deny with reason" editor for a request (opened by the card button or Shift+N).
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  useEffect(() => setReasonFor(null), [agent.id]);
  usePermissionKeys(agent, items, setReasonFor);
  const pendingId = latestPending(items)?.requestId ?? null;

  // Stable per-request callbacks so permission cards don't re-render on every frame.
  const reasonHandlers = useRef(new Map<string, (open: boolean) => void>());
  const reasonHandler = useCallback((requestId: string) => {
    let fn = reasonHandlers.current.get(requestId);
    if (!fn) {
      fn = (open: boolean) => setReasonFor(open ? requestId : null);
      reasonHandlers.current.set(requestId, fn);
    }
    return fn;
  }, []);

  const virtualRows = virtualizer.getVirtualItems();

  // "Thinking" indicator: busy agent, but nothing at the end of the timeline is visibly streaming.
  const lastRowItem = rows.length ? list[rows[rows.length - 1]] : undefined;
  const messageSettled = useQuietFor(
    lastRowItem?.kind === "agent_message" ? `${lastRowItem.id}:${lastRowItem.text.length}` : null,
    MESSAGE_SETTLE_MS,
  );
  const showThinking =
    !(loading && !items) &&
    (waiting ||
      shouldShowThinking(agent.status, lastRowItem, !!lastRowItem && groupItems.has(lastRowItem.id), messageSettled));
  const turnEnd = !loading && !showThinking ? turnEndOf(agent.status, list, lastRowItem, agent.lastActivityAt) : null;
  const fallbackStart = useRef(Date.now());
  useLayoutEffect(() => {
    if (!showThinking) fallbackStart.current = Date.now();
  }, [showThinking]);
  // Keep it in view when it appears while following the stream.
  useLayoutEffect(() => {
    if ((showThinking || turnEnd) && stick.current) scrollToBottom();
  }, [showThinking, turnEnd, scrollToBottom]);

  return (
    <div className="@container relative flex min-h-0 flex-1 flex-col">
      <LiveAnnouncer agent={agent} items={items} />
      {olderLoading && (
        <div
          role="status"
          className="glass pointer-events-none absolute left-1/2 top-2 z-10 flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-strong px-3 text-[11.5px] text-muted shadow-md"
        >
          <Spinner className="h-3 w-3" /> Loading earlier messages…
        </div>
      )}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={onWheel}
        onTouchMove={markIntent}
        onPointerDown={markIntent}
        onKeyDown={onKeyDownScroll}
        className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
        aria-busy={live}
      >
        <div className="mx-auto w-full max-w-[860px] px-3 pb-6 @lg:px-6 @[1280px]:max-w-[1000px]">
          {loading && !items ? (
            <div className="pt-4">
              <TimelineSkeleton />
            </div>
          ) : (
            <div
              role="list"
              aria-label="Conversation"
              className="relative w-full"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualRows.map((v) => {
                const it = list[rows[v.index]];
                if (!it) return null;
                const prev = v.index > 0 ? list[rows[v.index - 1]] : undefined;
                const group = groupItems.get(it.id);
                return (
                  <div
                    key={v.key}
                    role="listitem"
                    data-index={v.index}
                    ref={virtualizer.measureElement}
                    className={cn(
                      "absolute left-0 top-0 w-full pb-3",
                      spacingFor(it, prev),
                      flashId === it.id && "[&>*]:rounded-xl [&>*]:ring-2 [&>*]:ring-accent/50",
                    )}
                    style={{ transform: `translateY(${v.start}px)` }}
                  >
                    {group ? (
                      <ActivityGroup
                        groupId={it.id}
                        items={group}
                        agent={stableAgent}
                        live={live && !waiting && group[group.length - 1].id === lastId}
                        agentLive={stableAgent.running && stableAgent.status !== "interrupted"}
                        open={openGroups.has(it.id)}
                        onToggle={toggleGroup}
                      />
                    ) : (
                      renderItem(it, {
                        agent: stableAgent,
                        prev,
                        liveTail: live && it.id === lastId,
                        view,
                        childrenOf,
                        bgRunningIds,
                        lastPrompt: lastPrompt?.kind === "user_message" ? lastPrompt : null,
                        pendingId,
                        reasonFor,
                        reasonHandler,
                      })
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {showThinking && <ThinkingIndicator agent={agent} since={turnStart(list, fallbackStart.current)} />}
          {turnEnd && <TurnEndLine end={turnEnd} lastActivityAt={agent.lastActivityAt} />}
          {footer}
        </div>
      </div>
      {/* Its own strip below the conversation (not floating over it), so it never covers text. */}
      {!atBottom && (
        <div className="flex h-11 shrink-0 items-center justify-center border-t border-line/60 bg-base">
          <button
            type="button"
            onClick={() => {
              stick.current = true;
              setHasNew(false);
              setAtBottom(true);
              scrollToBottom();
            }}
            className="flex h-8 items-center gap-1.5 rounded-full border border-line-strong bg-card px-3 text-[12px] font-medium text-fg shadow-md shadow-black/30 edge transition-colors hover:border-accent/50"
          >
            {hasNew && <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_6px_var(--accent)]" />}
            {hasNew ? "New activity" : "Jump to latest"}
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

/** An agent message that stopped growing this long ago is done; the model is on its next step. */
const MESSAGE_SETTLE_MS = 1500;

/** True once `key` (null = not watching) has stayed the same for `ms`. */
function useQuietFor(key: string | null, ms: number): boolean {
  const [quietKey, setQuietKey] = useState<string | null>(null);
  useEffect(() => {
    if (key === null) return;
    const t = setTimeout(() => setQuietKey(key), ms);
    return () => clearTimeout(t);
  }, [key, ms]);
  return key !== null && quietKey === key;
}

/** Same object while the fields timeline rows read are unchanged. */
function useStableAgent(agent: Agent): Agent {
  const ref = useRef(agent);
  const a = ref.current;
  if (
    a.id !== agent.id ||
    a.provider !== agent.provider ||
    a.customAgentId !== agent.customAgentId ||
    a.status !== agent.status ||
    a.running !== agent.running ||
    a.worktree !== agent.worktree ||
    a.branch !== agent.branch ||
    a.baseBranch !== agent.baseBranch ||
    a.title !== agent.title ||
    a.accountId !== agent.accountId ||
    a.rateLimited !== agent.rateLimited
  ) {
    ref.current = agent;
  }
  return ref.current;
}

/** Extra space above a row (padding, so it's included in the measured height). */
function spacingFor(it: TimelineItem, prev: TimelineItem | undefined): string {
  if (!prev) return "";
  if (it.kind === "user_message") return "pt-4";
  if (prev.kind === "user_message") return "pt-1";
  return "";
}

type ToolItem = Extract<TimelineItem, { kind: "tool_call" }>;
type UserItem = Extract<TimelineItem, { kind: "user_message" }>;

/** Indices into the timeline (so streamed item updates need no rebuild). */
interface TimelineView {
  /** Top-level rows (sub-agent children are nested in their card). */
  top: number[];
  /** Collapsed activity runs: member indices keyed by the group id (its first item's id). */
  groups: Map<string, number[]>;
  /** Child call indices per sub-agent toolCallId (any depth). */
  children: Map<string, number[]>;
  /** Index of each sub-agent call by its toolCallId. */
  parentIdx: Map<string, number>;
  lastSummaryId: string | null;
  lastErrorId: string | null;
  lastPromptIdx: number | null;
}

const NO_ITEMS: TimelineItem[] = [];

function buildView(items: TimelineItem[], waiting = false): TimelineView {
  const parents = new Set<string>();
  const parentIdx = new Map<string, number>();
  items.forEach((it, i) => {
    if (it.kind === "tool_call" && it.subagent) {
      parents.add(it.toolCallId);
      parentIdx.set(it.toolCallId, i);
    }
  });
  const children = new Map<string, number[]>();
  let lastSummaryId: string | null = null;
  let lastErrorId: string | null = null;
  let lastPromptIdx: number | null = null;
  const top: number[] = [];
  items.forEach((it, i) => {
    // Children render inside their sub-agent card; orphans stay at top level.
    if (it.kind === "tool_call" && it.parentToolCallId && parents.has(it.parentToolCallId)) {
      const list = children.get(it.parentToolCallId) ?? [];
      list.push(i);
      children.set(it.parentToolCallId, list);
      return;
    }
    if (it.kind === "turn_summary") lastSummaryId = it.id;
    if (it.kind === "notice" && it.level === "error") lastErrorId = it.id;
    if (it.kind === "user_message") {
      lastPromptIdx = i;
      lastErrorId = null;
    }
    top.push(i);
  });
  const grouped = groupActivity(items, top, { foldTail: waiting });
  const groups = new Map<string, number[]>();
  for (const [first, idxs] of grouped.groups) groups.set(items[first].id, idxs);
  return { top: grouped.rows, groups, children, parentIdx, lastSummaryId, lastErrorId, lastPromptIdx };
}

function sameList<T>(a: T[] | undefined, b: T[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isToolItem(it: TimelineItem): it is ToolItem {
  return it.kind === "tool_call";
}

/**
 * Index lists (sub-agent children, activity groups) resolved to the current item objects. The map
 * keeps its identity (and each list too) while nothing inside changed, so memoized cards skip re-rendering.
 */
function useResolvedLists<T extends TimelineItem = TimelineItem>(
  src: Map<string, number[]>,
  items: TimelineItem[],
  keep?: (it: TimelineItem) => it is T,
): Map<string, T[]> {
  const prev = useRef<Map<string, T[]>>(new Map());
  if (src.size === 0) {
    if (prev.current.size) prev.current = new Map();
    return prev.current;
  }
  let changed = src.size !== prev.current.size;
  const next = new Map<string, T[]>();
  for (const [k, idxs] of src) {
    const resolved: T[] = [];
    for (const i of idxs) {
      const it = items[i];
      if (it && (!keep || keep(it))) resolved.push(it as T);
    }
    const old = prev.current.get(k);
    if (old && sameList(old, resolved)) next.set(k, old);
    else {
      next.set(k, resolved);
      changed = true;
    }
  }
  if (changed) prev.current = next;
  return prev.current;
}

/** toolCallIds of background sub-agents currently counted as running (same rule as the counts). */
function useBackgroundRunning(agentId: string): ReadonlySet<string> {
  const runs = useSubagentRuns(agentId);
  return useMemo(
    () => new Set(runs.filter((r) => r.state === "running" && r.background).map((r) => r.toolCallId)),
    [runs],
  );
}

function renderItem(
  it: TimelineItem,
  ctx: {
    agent: Agent;
    prev: TimelineItem | undefined;
    liveTail: boolean;
    view: TimelineView;
    childrenOf: Map<string, ToolItem[]>;
    bgRunningIds: ReadonlySet<string>;
    lastPrompt: UserItem | null;
    pendingId: string | null;
    reasonFor: string | null;
    reasonHandler: (requestId: string) => (open: boolean) => void;
  },
) {
  const { agent, prev, liveTail, view } = ctx;
  const agentLive = agent.running && agent.status !== "interrupted";
  switch (it.kind) {
    case "user_message":
      return <UserBubble item={it} />;
    case "agent_message":
      return (
        <AgentMessage item={it} agent={agent} showHeader={!prev || prev.kind === "user_message"} streaming={liveTail} />
      );
    case "thought":
      return <ThoughtBlock item={it} live={liveTail} agentId={agent.id} />;
    case "tool_call":
      if (it.subagent) {
        // Same rule as the sub-agent counts: a background sub-agent's call completes at launch but
        // it keeps running while subagentRuns counts it.
        const bgRunning = !!it.subagent.background && it.status === "completed" && ctx.bgRunningIds.has(it.toolCallId);
        return (
          <SubagentCard
            item={it}
            childrenOf={ctx.childrenOf}
            agentId={agent.id}
            agentLive={agentLive}
            bgRunning={bgRunning}
          />
        );
      }
      return <ToolCallCard item={it} agentId={agent.id} agentLive={agentLive} />;
    case "permission":
      return (
        <PermissionCard
          item={it}
          agent={agent}
          keyboard={it.requestId === ctx.pendingId}
          reasonOpen={ctx.reasonFor === it.requestId}
          onReasonOpenChange={ctx.reasonHandler(it.requestId)}
        />
      );
    case "plan":
      return <PlanCard item={it} />;
    case "notice":
      return <NoticeBanner item={it} agent={agent} lastPrompt={ctx.lastPrompt} isLatest={it.id === view.lastErrorId} />;
    case "turn_summary":
      return it.id === view.lastSummaryId ? <TurnSummaryCard item={it} agent={agent} /> : <TurnSummaryLine item={it} />;
    default:
      return null;
  }
}

function TimelineSkeleton() {
  return (
    <div className="space-y-6 pt-2" aria-label="Loading conversation">
      <div className="flex justify-end">
        <Skeleton className="h-14 w-[55%] rounded-2xl" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-[92%]" />
        <Skeleton className="h-3 w-[80%]" />
        <Skeleton className="h-3 w-[64%]" />
      </div>
      <Skeleton className="h-9 w-full rounded-xl" />
      <Skeleton className="h-9 w-full rounded-xl" />
      <div className="space-y-2">
        <Skeleton className="h-3 w-[88%]" />
        <Skeleton className="h-3 w-[70%]" />
      </div>
    </div>
  );
}

/**
 * Screen-reader announcements for new items and status changes only. The timeline
 * itself isn't a live region (streaming deltas would be read out character by character).
 */
function LiveAnnouncer({ agent, items }: { agent: Agent; items: TimelineItem[] | undefined }) {
  const [message, setMessage] = useState("");
  const name = useIdentity(agent.provider, agent.customAgentId).short;
  const lastId = items?.[items.length - 1]?.id;
  const lastKind = items?.[items.length - 1]?.kind;
  const lastTitle = (() => {
    const it = items?.[items.length - 1];
    return it && (it.kind === "permission" || it.kind === "tool_call") ? it.title : "";
  })();
  const seen = useRef<string | undefined>(lastId);
  const status = useRef(agent.status);

  useEffect(() => {
    if (lastId && lastId !== seen.current) {
      seen.current = lastId;
      if (lastKind === "agent_message") setMessage(`${name} replied`);
      else if (lastKind === "permission") setMessage(`${name} needs approval: ${lastTitle}`);
      else if (lastKind === "tool_call") setMessage(`${name}: ${lastTitle}`);
    }
  }, [lastId, lastKind, lastTitle, name]);

  useEffect(() => {
    if (agent.status === status.current) return;
    status.current = agent.status;
    if (agent.status === "idle") setMessage(`${name} finished`);
    else if (agent.status === "error") setMessage(`${name} stopped with an error`);
  }, [agent.status, name]);

  return (
    <div className="sr-only" role="status" aria-live="polite">
      {message}
    </div>
  );
}
