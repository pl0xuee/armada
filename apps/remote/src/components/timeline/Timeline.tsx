import { memo, useCallback, useMemo } from "react";
import { discardPrompt, loadOlder, sendPrompt } from "@/lib/controller";
import { useStore } from "@/lib/store";
import { Spinner } from "../Icon";
import { isBusy } from "@/lib/meta";
import { buildRows, estimateRow, sameRow, type Row } from "@/lib/rows";
import type { PendingPrompt } from "@/lib/store";
import type { Agent, TimelineItem } from "@/lib/types";
import { VirtualList } from "../VirtualList";
import { AgentMessage, NoticeRow, PlanCard, ThoughtRow, ToolGroup, TypingDots, UserBubble } from "./Items";
import { PermissionCard } from "./Permission";
import { QuestionCard } from "./Question";
import { SubagentCard, TurnSummaryCard } from "./Subagents";

const rowKey = (r: Row) => r.key;

/** Rows are rebuilt on every change; this skips re-rendering the ones whose items didn't change. */
const TimelineRow = memo(
  function TimelineRow({ row, streaming, readOnly, latest }: { row: Row; streaming: boolean; readOnly: boolean; latest: boolean }) {
    if (row.kind === "tools") return <ToolGroup items={row.tools} />;
    if (row.kind === "subagent") return <SubagentCard node={row.node} />;
    const it = row.item;
    switch (it.kind) {
      case "user_message":
        return <UserBubble text={it.text} ts={it.ts} attachments={it.attachments} />;
      case "agent_message":
        return <AgentMessage item={it} streaming={streaming} />;
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
  (a, b) => a.streaming === b.streaming && a.readOnly === b.readOnly && a.latest === b.latest && sameRow(a.row, b.row),
);

export const Timeline = memo(function Timeline({
  agent,
  items,
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
  const rows = useMemo(() => buildRows(items), [items]);
  const busy = isBusy(agent.status) && agent.status !== "needs_permission";
  const lastItem = items[items.length - 1];
  const streamingId =
    busy && !pending.length && lastItem && (lastItem.kind === "agent_message" || lastItem.kind === "thought") ? lastItem.id : null;
  const showWorking = busy && !streamingId;

  const latestSummary = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === "turn_summary") return items[i].id;
    return null;
  }, [items]);
  const render = useCallback(
    (row: Row) => <TimelineRow row={row} streaming={row.key === streamingId} readOnly={readOnly} latest={row.key === latestSummary} />,
    [streamingId, readOnly, latestSummary],
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
        {showWorking && (
          <div className="flex items-center gap-2 pl-0.5 text-[13px] text-steel">
            <TypingDots />
            <span>{agent.status === "starting" ? "Starting session…" : "Working…"}</span>
          </div>
        )}
      </div>
    </div>
  );
});
