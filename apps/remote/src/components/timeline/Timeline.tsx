import { memo, useCallback, useMemo, useRef, useState } from "react";
import { openGroupKeys } from "@/lib/activity";
import { discardPrompt, loadOlder, sendPrompt } from "@/lib/controller";
import { inheritedConfig, runningSubagents, useHeld, useSubagentState, WAITING_HOLD_MS, type InheritedConfig } from "@/lib/subagents";
import { useStore } from "@/lib/store";
import { Spinner } from "../Icon";
import { agentIdentity, isBusy } from "@/lib/meta";
import { buildRows, estimateRow, finalAnswerIds, isPictureOnly, sameRow, withoutResumeNotice, type Row } from "@/lib/rows";
import type { PendingPrompt } from "@/lib/store";
import { turnStart, waitingStatus } from "@/lib/thinking";
import type { Agent, TimelineItem } from "@/lib/types";
import { VirtualList } from "../VirtualList";
import { ActivityGroup } from "./ActivityGroup";
import { AgentMessage, NoticeRow, PlanCard, ThoughtRow, ToolGroup, UserBubble } from "./Items";
import { LiveStatus } from "./LiveStatus";
import { isPlanApproval } from "@shared/planApproval";
import { PermissionCard } from "./Permission";
import { PlanApprovalCard } from "./PlanApproval";
import { QuestionCard } from "./Question";
import { SubagentCard, TurnSummaryCard } from "./Subagents";

const rowKey = (r: Row) => r.key;

const NO_OPEN: ReadonlySet<string> = new Set();
const NO_ITEMS: TimelineItem[] = [];
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
    inherited,
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
    /** The main agent's model and effort, for sub-agents that name none. */
    inherited: InheritedConfig;
    /** Activity group: it holds the latest item of a working agent. */
    live: boolean;
    open: boolean;
    onToggleGroup: (id: string) => void;
  }) {
    if (row.kind === "tools") return <ToolGroup items={row.tools} agentLive={agentLive} />;
    if (row.kind === "group")
      return <ActivityGroup groupId={row.key} items={row.items} live={live} agentLive={agentLive} open={open} onToggle={onToggleGroup} />;
    if (row.kind === "subagent") return <SubagentCard node={row.node} agentLive={agentLive} bgRunning={bgRunning} inherited={inherited} />;
    const it = row.item;
    switch (it.kind) {
      case "user_message":
        return <UserBubble text={it.text} ts={it.ts} attachments={it.attachments} />;
      case "agent_message":
        return <AgentMessage item={it} streaming={streaming} interim={interim} />;
      case "thought":
        return <ThoughtRow item={it} streaming={streaming} />;
      case "permission":
        return isPlanApproval(it) ? <PlanApprovalCard item={it} readOnly={readOnly} /> : <PermissionCard item={it} readOnly={readOnly} />;
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
    a.inherited === b.inherited &&
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
  const { running: runningNow, runs, bgRunning } = useSubagentState(agent, items);
  // Sticky: the count can dip to 0 for a moment between a background sub-agent's turns.
  const subagents = useHeld(runningNow, 0, WAITING_HOLD_MS);
  const waiting = subagents > 0 && waitingStatus(agent.status);
  const agentLive = agent.running && agent.status !== "interrupted";

  // Folding depends only on what the items are (see `groupActivity`), never on what is on screen or on
  // whether the agent is waiting, so rows never flip between folded and open under the reader.
  const rows = useMemo(() => buildRows(items), [items]);
  const rowsByKey = useRef(new Map<string, Row>());
  rowsByKey.current = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);

  const busy = isBusy(agent.status) && agent.status !== "needs_permission";
  const lastItem = items[items.length - 1];
  // A picture-only reply isn't text that can still grow: the agent is still "working" below it.
  const streamingId =
    busy && !pending.length && lastItem && (lastItem.kind === "thought" || (lastItem.kind === "agent_message" && !isPictureOnly(lastItem)))
      ? lastItem.id
      : null;
  // The one status line under the last message (streaming text and thoughts included): it says what is happening.
  const showLive = waiting || busy;
  const name = useStore((s) => agentIdentity(agent, s.customAgents).short);
  const running = useMemo(() => runningSubagents(items, runs), [items, runs]);
  const inherited = useMemo(() => inheritedConfig(agent), [agent.configOptions, agent.model]);
  // Kept per agent, like the open groups: the list of running sub-agents stays open across re-renders.
  const [subsOpenFor, setSubsOpenFor] = useState<string | null>(null);
  const toggleSubs = useCallback(() => setSubsOpenFor((id) => (id === agent.id ? null : agent.id)), [agent.id]);
  // The group holding the latest item of a working agent spins while it is being filled.
  const liveGroup = useMemo(() => {
    const last = rows[rows.length - 1];
    return busy && !waiting && last?.kind === "group" && last.items[last.items.length - 1] === lastItem ? last.key : null;
  }, [rows, busy, waiting, lastItem]);

  // Groups the reader opened (kept here so it survives row virtualization). A group is never opened on its own,
  // not even the live one, so content
  // never expands or snaps shut under a reader who isn't pinned to the bottom.
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
        inherited={inherited}
        live={row.key === liveGroup}
        open={row.kind === "group" && openGroups.has(row.key)}
        onToggleGroup={toggleGroup}
      />
    ),
    [streamingId, readOnly, latestSummary, finals, agentLive, bgRunning, inherited, liveGroup, openGroups, toggleGroup],
  );

  const hasMore = useStore((s) => !!s.timelines[agent.id]?.hasMore);
  const loadingOlder = useStore((s) => !!s.timelines[agent.id]?.loadingOlder);
  const onReachTop = useCallback(() => void loadOlder(agent.id), [agent.id]);

  return (
    <div>
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
        {showLive && (
          <LiveStatus
            agent={agent}
            name={name}
            // Queued sends mean the newest item is stale: don't name its step.
            items={pending.length ? NO_ITEMS : items}
            subagents={waiting ? subagents : 0}
            running={running}
            since={pending.length ? 0 : turnStart(items, 0)}
            open={subsOpenFor === agent.id}
            onToggle={toggleSubs}
          />
        )}
      </div>
    </div>
  );
});
