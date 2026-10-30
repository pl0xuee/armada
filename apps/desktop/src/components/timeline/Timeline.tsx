import { ArrowDown } from "lucide-react";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type { Agent, TimelineItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useIdentity } from "@/hooks/useIdentity";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { Spinner } from "../ui/misc";
import { Skeleton } from "../ui/skeleton";
import {
  AgentMessage,
  NoticeBanner,
  PermissionCard,
  PlanCard,
  ThoughtBlock,
  ToolCallCard,
  TurnHeader,
  UserBubble,
} from "./items";
import { ActivityGroup } from "./ActivityGroup";
import { finalAnswers, groupActivity, nextKeep, type KeepRow } from "./activityGroups";
import { SubagentCard } from "./SubagentCard";
import { useRunningSubagentCount, useSubagentRuns } from "../agent/useSubagents";
import { useHeld, WAITING_HOLD_MS } from "@/hooks/useHeld";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { shouldShowThinking, turnEndOf, turnStart, waitingStatus } from "./thinking";
import { TurnEndLine } from "./TurnEndLine";
import { TurnSummaryCard, TurnSummaryLine } from "./TurnSummaryCard";
import { QuestionCard, questionCardSelector } from "./QuestionCard";
import { latestPending, usePermissionKeys } from "./usePermissionKeys";
import { latestPendingQuestion } from "@/lib/question";

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
      return 60 + Math.min(900, Math.floor(it.text.length / 80) * 24) + (it.images?.length ? 340 : 0);
    case "thought":
      return 34;
    case "tool_call":
      return it.subagent ? 150 : it.images?.length ? 380 : 48;
    case "permission":
      return it.resolution === null ? 220 : 48;
    case "question":
      return it.resolution === null ? 120 + it.fields.length * 150 : 48 + it.fields.length * 22;
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
  focused = true,
  footer,
}: {
  agent: Agent;
  items: TimelineItem[] | undefined;
  loading: boolean;
  /** This pane has the keyboard (side by side, only one does): card keys act here alone. */
  focused?: boolean;
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
  // While sub-agents run, a brand-new unattributed call is usually a sub-agent's, named a moment
  // later: held back briefly so it goes straight into its card instead of flashing in the chat.
  const unattributed = useUnattributedHold(list, waiting);
  // Tall standalone rows on screen stay unfolded (not absorbed into an activity group) until they scroll
  // fully out of view, so a run folding never collapses content the reader is looking at.
  const keepRef = useRef<ReadonlySet<string>>(new Set());
  const [, bumpKeep] = useReducer((n: number) => n + 1, 0);
  const keepKey = [...keepRef.current].join(",");
  const structureKey = `${keepKey}:${list.length}:${list[0]?.id ?? ""}:${list[list.length - 1]?.id ?? ""}:${attributed}:${waiting}:${[...unattributed].join(",")}`;
  // Keyed on structure on purpose: it reads the current list, but deltas never change the structure.
  const view = useMemo(() => buildView(list, waiting, unattributed, keepRef.current), [structureKey]);
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

  const syncKeep = useRef<(inst: Virtualizer<HTMLDivElement, Element>) => void>(() => {});
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
      syncKeep.current(inst);
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

  syncKeep.current = (inst) => {
    const el = scrollRef.current;
    if (!el) return;
    const items = inst.getVirtualItems();
    const visible: KeepRow[] = items.map((v) => {
      const id = list[rows[v.index]]?.id ?? "";
      return { id, standalone: !groupItems.has(id), start: v.start, end: v.end };
    });
    const byId = new Map<string, number>();
    rows.forEach((r, i) => {
      const id = list[r]?.id;
      if (id && keepRef.current.has(id)) byId.set(id, i);
    });
    const next = nextKeep(
      keepRef.current,
      visible,
      (id) => {
        const m = inst.measurementsCache[byId.get(id) ?? -1];
        return m && { start: m.start, end: m.end };
      },
      { top: el.scrollTop, bottom: el.scrollTop + el.clientHeight },
      stick.current,
    );
    if (next === keepRef.current) return;
    const released = [...keepRef.current].some((id) => !next.has(id));
    keepRef.current = next;
    if (released) bumpKeep();
  };
  // Rows mount/measure after render: refresh the kept set once the DOM settles too.
  useLayoutEffect(() => syncKeep.current(virtualizer));

  // Rows re-measure (and the thinking line / footer resize) after the virtualizer's onChange has
  // already pinned: its scrollHeight was still the old one then. Re-pin whenever the content grows.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const el = scrollRef.current;
      if (el && stick.current && el.scrollHeight - el.scrollTop - el.clientHeight > 1) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

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
    // Scrolling up stops following at once — unless a nested scroller under the pointer (command
    // output, code block, wide table) takes the wheel and the conversation doesn't move at all.
    const el = scrollRef.current;
    // (Nothing to do when the conversation can't scroll up: no scroll event would ever clear it.)
    if (e.deltaY < 0 && el && el.scrollTop > 0 && !nestedScrollTakes(e.target, el, e.deltaY)) {
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
  usePermissionKeys(agent, items, setReasonFor, focused);
  const pendingId = (focused && latestPending(items)?.requestId) || null;
  const questionId = (focused && latestPendingQuestion(items)?.requestId) || null;

  // A pending question taller than the viewport opens with its top in view (sticking to the bottom
  // would cut off the header and the first question, which is where the keys act). Following the
  // stream resumes once it's answered.
  const pendingQuestion = latestPendingQuestion(items)?.requestId ?? null;
  const heldForQuestion = useRef(false);
  useEffect(() => {
    if (!pendingQuestion) {
      if (heldForQuestion.current) {
        heldForQuestion.current = false;
        stick.current = true;
        setAtBottom(true);
        scrollToBottom();
      }
      return;
    }
    if (!stick.current) return;
    let frame = 0;
    let tries = 0;
    const place = () => {
      const el = scrollRef.current;
      const card = el?.querySelector<HTMLElement>(questionCardSelector(pendingQuestion));
      if (!el || !card) {
        // The row mounts and measures a frame or two after the item arrives.
        if (tries++ < 12) frame = requestAnimationFrame(place);
        return;
      }
      if (card.offsetHeight <= el.clientHeight - 24) return;
      const top = card.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      heldForQuestion.current = true;
      stick.current = false;
      setAtBottom(false);
      el.scrollTop = Math.max(0, top - 12);
      lastTop.current = el.scrollTop;
    };
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [pendingQuestion, agent.id, scrollToBottom]);

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
    <div data-agent-id={agent.id} className="@container relative flex min-h-0 flex-1 flex-col">
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
        <div ref={contentRef} className="mx-auto w-full max-w-[780px] px-3.5 pb-6 @lg:px-6">
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
                const turnStart = startsAgentTurn(it, prev, hasOlder);
                return (
                  <div
                    key={v.key}
                    role="listitem"
                    data-index={v.index}
                    ref={virtualizer.measureElement}
                    className={cn(
                      "absolute left-0 top-0 w-full",
                      spacingFor(it, prev, !!group, !!prev && groupItems.has(prev.id)),
                      flashId === it.id && "[&>*]:rounded-xl [&>*]:ring-2 [&>*]:ring-accent/50",
                    )}
                    style={{ transform: `translateY(${v.start}px)` }}
                  >
                    {turnStart && <TurnHeader agent={stableAgent} ts={it.ts} />}
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
                        questionId,
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
      {/* Floats over the conversation instead of taking layout space: a strip that shrinks the
          scroller when it appears leaves the bottom 44px out of reach of the "at bottom" check, so
          it would never go away. Only shown while scrolled up, so it never hides the last lines. */}
      {!atBottom && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
          <button
            type="button"
            onClick={() => {
              stick.current = true;
              setHasNew(false);
              setAtBottom(true);
              scrollToBottom();
            }}
            className="glass pointer-events-auto flex h-8 items-center gap-1.5 rounded-full border border-line-strong px-3 text-[12px] font-medium text-fg shadow-md shadow-black/30 edge transition-colors hover:border-accent/50"
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

/** Quiet one-line rows (traces): tight to each other, so a run of them reads as one block. */
function isTrace(it: TimelineItem, isGroup: boolean): boolean {
  return isGroup || it.kind === "thought" || (it.kind === "tool_call" && !it.subagent);
}

/**
 * One vertical rhythm, in padding (so it's part of the measured row height): 12px between blocks
 * of a turn, 24px between turns, 4px between trace rows.
 */
function spacingFor(it: TimelineItem, prev: TimelineItem | undefined, isGroup: boolean, prevIsGroup: boolean): string {
  const trace = isTrace(it, isGroup);
  const base = trace ? "pb-1" : "pb-3";
  if (!prev) return base;
  if (it.kind === "user_message") return cn(base, "pt-3");
  // After a trace row (always 4px below it), a non-trace row needs the rest of 12px.
  if (!trace && isTrace(prev, prevIsGroup)) return cn(base, "pt-2");
  return base;
}

/** First visible row of an agent turn (right after the user's message): carries the avatar + name header. */
function startsAgentTurn(it: TimelineItem, prev: TimelineItem | undefined, hasOlder: boolean): boolean {
  if (it.kind === "user_message" || it.kind === "notice" || it.kind === "turn_summary") return false;
  return prev ? prev.kind === "user_message" : !hasOlder;
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
  /** Item ids of each turn's closing agent message (others are interim narration). */
  finalIds: Set<string>;
  lastSummaryId: string | null;
  lastErrorId: string | null;
  lastPromptIdx: number | null;
}

const NO_ITEMS: TimelineItem[] = [];

/** Whether an element between `target` and `root` can still scroll vertically by `deltaY`. */
export function nestedScrollTakes(target: EventTarget | null, root: HTMLElement | null, deltaY: number): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== root; el = el.parentElement) {
    if (!(el instanceof HTMLElement) || el.scrollHeight <= el.clientHeight + 1) continue;
    const overflow = getComputedStyle(el).overflowY;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    if (deltaY < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
  }
  return false;
}

/** How long a new top-level tool call may wait for its sub-agent attribution (see Timeline). */
export const ATTRIBUTION_GRACE_MS = 5000;

/** Ids of tool calls still within their attribution grace (re-renders as each one expires). */
export function heldUnattributed(items: TimelineItem[], waiting: boolean, now: number): string[] {
  if (!waiting) return [];
  const out: string[] = [];
  for (const it of items) {
    if (it.kind !== "tool_call" || it.subagent || it.parentToolCallId) continue;
    // A timestamp from the future (clock skew) can't be judged: never hold it for longer than the grace.
    const age = now - it.ts;
    if (age < ATTRIBUTION_GRACE_MS && age > -ATTRIBUTION_GRACE_MS) out.push(it.id);
  }
  return out;
}

function useUnattributedHold(items: TimelineItem[], waiting: boolean): ReadonlySet<string> {
  const [now, setNow] = useState(() => Date.now());
  const held = heldUnattributed(items, waiting, Date.now());
  const key = held.join(",");
  useEffect(() => {
    if (!held.length) return;
    // Wake when the oldest held call's grace ends.
    const byId = new Map(items.map((it) => [it.id, it.ts]));
    const next = Math.min(...held.map((id) => (byId.get(id) ?? now) + ATTRIBUTION_GRACE_MS));
    // Never sleep longer than the grace itself.
    const t = setTimeout(
      () => setNow(Date.now()),
      Math.min(ATTRIBUTION_GRACE_MS + 50, Math.max(50, next - Date.now() + 20)),
    );
    return () => clearTimeout(t);
  }, [key, now]);
  return useMemo(() => new Set(held), [key]);
}

function buildView(
  items: TimelineItem[],
  waiting = false,
  hold: ReadonlySet<string> = new Set(),
  keep?: ReadonlySet<string>,
): TimelineView {
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
    if (hold.has(it.id)) return;
    if (it.kind === "turn_summary") lastSummaryId = it.id;
    if (it.kind === "notice" && it.level === "error") lastErrorId = it.id;
    if (it.kind === "user_message") {
      lastPromptIdx = i;
      lastErrorId = null;
    }
    top.push(i);
  });
  const grouped = groupActivity(items, top, { foldTail: waiting, keep });
  const groups = new Map<string, number[]>();
  for (const [first, idxs] of grouped.groups) groups.set(items[first].id, idxs);
  const finalIds = new Set<string>();
  for (const i of finalAnswers(items, top)) finalIds.add(items[i].id);
  return { top: grouped.rows, groups, children, parentIdx, finalIds, lastSummaryId, lastErrorId, lastPromptIdx };
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
    questionId: string | null;
    reasonFor: string | null;
    reasonHandler: (requestId: string) => (open: boolean) => void;
  },
) {
  const { agent, liveTail, view } = ctx;
  const agentLive = agent.running && agent.status !== "interrupted";
  switch (it.kind) {
    case "user_message":
      return <UserBubble item={it} />;
    case "agent_message":
      return <AgentMessage item={it} agent={agent} interim={!view.finalIds.has(it.id)} streaming={liveTail} />;
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
    case "question":
      return <QuestionCard item={it} agent={agent} keyboard={it.requestId === ctx.questionId} />;
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
    return it && (it.kind === "permission" || it.kind === "tool_call")
      ? it.title
      : it?.kind === "question"
        ? it.message
        : "";
  })();
  const seen = useRef<string | undefined>(lastId);
  const status = useRef(agent.status);

  useEffect(() => {
    if (lastId && lastId !== seen.current) {
      seen.current = lastId;
      if (lastKind === "agent_message") setMessage(`${name} replied`);
      else if (lastKind === "permission") setMessage(`${name} needs approval: ${lastTitle}`);
      else if (lastKind === "question") setMessage(`${name} asks: ${lastTitle}`);
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
