import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nextKeep, openGroupKeys, type KeepRow } from "@/lib/activity";
import { discardPrompt, loadOlder, sendPrompt } from "@/lib/controller";
import { useHeld, useSubagentState, WAITING_HOLD_MS } from "@/lib/subagents";
import { useStore } from "@/lib/store";
import { Spinner } from "../Icon";
import { agentIdentity, isBusy } from "@/lib/meta";
import { buildRows, estimateRow, finalAnswerIds, isPictureOnly, sameRow, withoutResumeNotice, type Row } from "@/lib/rows";
import type { PendingPrompt } from "@/lib/store";
import { ELAPSED_AFTER_MS, formatElapsed, turnStart, VERB_MS, waitingStatus, workingLabel } from "@/lib/thinking";
import type { Agent, TimelineItem } from "@/lib/types";
import { VirtualList } from "../VirtualList";
import { ActivityGroup } from "./ActivityGroup";
import { AgentMessage, NoticeRow, PlanCard, ThoughtRow, ToolGroup, TypingDots, UserBubble } from "./Items";
import { PermissionCard } from "./Permission";
import { QuestionCard } from "./Question";
import { SubagentCard, TurnSummaryCard } from "./Subagents";

const rowKey = (r: Row) => r.key;

const NO_KEEP: ReadonlySet<string> = new Set();
const NO_OPEN: ReadonlySet<string> = new Set();
/** The bottom padding every virtualized row carries (VirtualList's `pb-4`). */
const ROW_GAP = 16;
/** Within this distance of the page bottom the reader counts as following the stream. */
const PIN_PX = 96;

/** Rows that can be folded into a group: the ones a kept (unfolded) set is about. */
const foldable = (r: Row) =>
  r.kind === "tools" || (r.kind === "item" && (r.item.kind === "agent_message" || r.item.kind === "thought"));

/** Rows are rebuilt on every change; this skips re-rendering the ones whose items didn't change. */
const TimelineRow = memo(
  function TimelineRow({
    row,
    streaming,
    readOnly,
    latest,
    interim,
    agentLive,
    bgRunning,
    live,
    open,
    onToggleGroup,
  }: {
    row: Row;
    streaming: boolean;
    readOnly: boolean;
    latest: boolean;
    interim: boolean;
    /** The agent process is running (false: interrupted / stopped, so unfinished calls are paused). */
    agentLive: boolean;
    bgRunning: ReadonlySet<string>;
    /** Activity group: it holds the latest item of a working agent. */
    live: boolean;
    open: boolean;
    onToggleGroup: (id: string) => void;
  }) {
    if (row.kind === "tools") return <ToolGroup items={row.tools} agentLive={agentLive} />;
    if (row.kind === "group")
      return <ActivityGroup groupId={row.key} items={row.items} live={live} agentLive={agentLive} open={open} onToggle={onToggleGroup} />;
    if (row.kind === "subagent") return <SubagentCard node={row.node} agentLive={agentLive} bgRunning={bgRunning} />;
    const it = row.item;
    switch (it.kind) {
      case "user_message":
        return <UserBubble text={it.text} ts={it.ts} attachments={it.attachments} />;
      case "agent_message":
        return <AgentMessage item={it} streaming={streaming} interim={interim} />;
      case "thought":
        return <ThoughtRow item={it} streaming={streaming} />;
      case "permission":
        return <PermissionCard item={it} readOnly={readOnly} />;
      case "question":
        return <QuestionCard item={it} readOnly={readOnly} />;
      case "plan":
        return <PlanCard item={it} />;
      case "notice":
        return <NoticeRow item={it} />;
      case "turn_summary":
        return <TurnSummaryCard item={it} latest={latest} />;
      default:
        return null; // item kinds from a newer desktop version
    }
  },
  (a, b) =>
    a.streaming === b.streaming &&
    a.readOnly === b.readOnly &&
    a.latest === b.latest &&
    a.interim === b.interim &&
    a.agentLive === b.agentLive &&
    a.bgRunning === b.bgRunning &&
    a.live === b.live &&
    a.open === b.open &&
    a.onToggleGroup === b.onToggleGroup &&
    sameRow(a.row, b.row),
);

export const Timeline = memo(function Timeline({
  agent,
  items: allItems,
  pending,
  readOnly,
  onEditPrompt,
}: {
  agent: Agent;
  items: TimelineItem[];
  pending: PendingPrompt[];
  readOnly: boolean;
  onEditPrompt: (text: string) => void;
}) {
  const items = useMemo(() => withoutResumeNotice(allItems, agent.status), [allItems, agent.status]);
  // Sub-agents still running (background ones keep running after their launch call completed).
  const { running: runningNow, bgRunning } = useSubagentState(agent, items);
  // Sticky: the count can dip to 0 for a moment between a background sub-agent's turns.
  const subagents = useHeld(runningNow, 0, WAITING_HOLD_MS);
  const waiting = subagents > 0 && waitingStatus(agent.status);
  const agentLive = agent.running && agent.status !== "interrupted";

  // Tall standalone rows on screen stay unfolded (not absorbed into an activity group) until they scroll
  // fully out of view, so a run folding never collapses content the reader is looking at.
  const root = useRef<HTMLDivElement>(null);
  const keepRef = useRef<ReadonlySet<string>>(NO_KEEP);
  const [keepState, setKeepState] = useState<{ id: string; keep: ReadonlySet<string> }>({ id: agent.id, keep: NO_KEEP });
  const keep = keepState.id === agent.id ? keepState.keep : NO_KEEP;
  keepRef.current = keep;

  const rows = useMemo(() => buildRows(items, { foldTail: waiting, keep }), [items, waiting, keep]);
  const rowsByKey = useRef(new Map<string, Row>());
  rowsByKey.current = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);

  const syncKeep = useCallback(() => {
    const el = root.current;
    if (!el) return;
    const rects = new Map<string, { start: number; end: number }>();
    const visible: KeepRow[] = [];
    for (const node of el.querySelectorAll<HTMLElement>("[data-vkey]")) {
      const id = node.dataset.vkey ?? "";
      const row = rowsByKey.current.get(id);
      if (!row) continue;
      const r = node.getBoundingClientRect();
      const pos = { start: r.top, end: r.bottom - ROW_GAP };
      rects.set(id, pos);
      visible.push({ id, standalone: foldable(row), ...pos });
    }
    const pinned = document.documentElement.scrollHeight - window.scrollY - window.innerHeight < PIN_PX;
    const next = nextKeep(keepRef.current, visible, (id) => rects.get(id), { top: 0, bottom: window.innerHeight }, pinned);
    if (next !== keepRef.current) {
      keepRef.current = next;
      setKeepState({ id: agent.id, keep: next });
    }
  }, [agent.id]);
  // Rows mount and measure after render, and the reader scrolls: refresh the kept set on both.
  useEffect(syncKeep);
  useEffect(() => {
    let raf = 0;
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), syncKeep()));
    };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [syncKeep]);

  const busy = isBusy(agent.status) && agent.status !== "needs_permission";
  const lastItem = items[items.length - 1];
  // A picture-only reply isn't text that can still grow: the agent is still "working" below it.
  const streamingId =
    busy && !pending.length && lastItem && (lastItem.kind === "thought" || (lastItem.kind === "agent_message" && !isPictureOnly(lastItem)))
      ? lastItem.id
      : null;
  const showWorking = waiting || (busy && !streamingId);
  // The group holding the latest item of a working agent shows its current step in its folded line.
  const liveGroup = useMemo(() => {
    const last = rows[rows.length - 1];
    return busy && !waiting && last?.kind === "group" && last.items[last.items.length - 1] === lastItem ? last.key : null;
  }, [rows, busy, waiting, lastItem]);

  // Groups the reader opened (kept here so it survives row virtualization). A group is never opened on its own,
  // not even the live one: it shows the current step in its folded line (the desktop does the same), so
  // content never expands or snaps shut under a reader who isn't pinned to the bottom.
  const [openState, setOpenState] = useState<{ id: string; open: ReadonlySet<string> }>({ id: agent.id, open: NO_OPEN });
  const groupOpen = openState.id === agent.id ? openState.open : NO_OPEN;
  // The state is keyed by a group's first member, which changes when runs merge (a barrier row releases and
  // the run before it joins): a group is open when any of its members was the one opened.
  const openGroups = useMemo(() => openGroupKeys(rows, groupOpen), [rows, groupOpen]);
  const openGroupsRef = useRef(openGroups);
  openGroupsRef.current = openGroups;
  const toggleGroup = useCallback(
    (id: string) =>
      setOpenState((s) => {
        const prev = s.id === agent.id ? s.open : NO_OPEN;
        const next = new Set(prev);
        const row = rowsByKey.current.get(id);
        if (openGroupsRef.current.has(id)) {
          // Close: forget every member that carried the open state.
          next.delete(id);
          if (row?.kind === "group") for (const it of row.items) next.delete(it.id);
        } else next.add(id);
        return { id: agent.id, open: next };
      }),
    [agent.id],
  );

  const latestSummary = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === "turn_summary") return items[i].id;
    return null;
  }, [items]);
  const finals = useMemo(() => finalAnswerIds(items), [items]);
  const render = useCallback(
    (row: Row) => (
      <TimelineRow
        row={row}
        streaming={row.key === streamingId}
        readOnly={readOnly}
        latest={row.key === latestSummary}
        interim={row.kind === "item" && row.item.kind === "agent_message" && !finals.has(row.item.id)}
        agentLive={agentLive}
        bgRunning={bgRunning}
        live={row.key === liveGroup}
        open={row.kind === "group" && openGroups.has(row.key)}
        onToggleGroup={toggleGroup}
      />
    ),
    [streamingId, readOnly, latestSummary, finals, agentLive, bgRunning, liveGroup, openGroups, toggleGroup],
  );

  const hasMore = useStore((s) => !!s.timelines[agent.id]?.hasMore);
  const loadingOlder = useStore((s) => !!s.timelines[agent.id]?.loadingOlder);
  const onReachTop = useCallback(() => void loadOlder(agent.id), [agent.id]);

  return (
    <div ref={root}>
      {(hasMore || loadingOlder) && (
        <div className="flex h-10 items-center justify-center gap-2 text-[12.5px] text-steel" role="status">
          {loadingOlder ? (
            <>
              <Spinner size={14} /> Loading earlier messages…
            </>
          ) : (
            <button type="button" onClick={onReachTop} className="press h-11 px-3 font-medium text-accent">
              Load earlier messages
            </button>
          )}
        </div>
      )}
      <VirtualList items={rows} getKey={rowKey} estimate={estimateRow} render={render} onReachTop={hasMore ? onReachTop : undefined} />
      <div className="space-y-4">
        {pending.map((p) => (
          <UserBubble
            key={p.id}
            text={p.text}
            attachments={p.attachments}
            progress={p.progress}
            state={p.failed ? "failed" : "sending"}
            onRetry={() => void sendPrompt(agent.id, p.text, p.attachments, p.id)}
            onEdit={() => {
              discardPrompt(agent.id, p.id);
              onEditPrompt(p.text);
            }}
          />
        ))}
        {showWorking && <WorkingIndicator agent={agent} subagents={subagents} since={pending.length ? 0 : turnStart(items, 0)} />}
      </div>
    </div>
  );
});

/**
 * "The agent is busy", in the desktop's words: a cycling verb with the turn's elapsed time, or
 * "Waiting on N sub-agents".
 */
const WorkingIndicator = memo(function WorkingIndicator({ agent, subagents, since }: { agent: Agent; subagents: number; since: number }) {
  const name = useStore((s) => agentIdentity(agent, s.customAgents).short);
  const [tick, setTick] = useState(0);
  const mounted = useRef(Date.now());
  const offset = useRef(Math.floor(Math.random() * 8));
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  void tick;
  const now = Date.now();
  // Without a prompt in view (older messages not loaded) count from when the indicator appeared.
  const elapsed = now - (since || mounted.current);
  const label = workingLabel({
    starting: agent.status === "starting",
    name,
    subagents,
    verb: Math.floor((now - mounted.current) / VERB_MS),
    offset: offset.current,
  });
  return (
    <div className="flex items-center gap-2 pl-0.5 text-[13px] text-steel" role="status" aria-label={`${name} is working`}>
      <TypingDots label={label} />
      <span className="min-w-0 truncate">{label}</span>
      {elapsed >= ELAPSED_AFTER_MS && <span className="shrink-0 text-[12px] tabular">· {formatElapsed(elapsed)}</span>}
    </div>
  );
});
