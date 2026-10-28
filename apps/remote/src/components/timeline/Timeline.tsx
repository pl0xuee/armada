import { useMemo, useState } from "react";
import { discardPrompt, sendPrompt } from "@/lib/controller";
import { isBusy } from "@/lib/meta";
import { noteUserLayoutChange } from "@/lib/scroll";
import type { PendingPrompt } from "@/lib/store";
import type { Agent, TimelineItem, ToolCallItem } from "@/lib/types";
import { AgentMessage, NoticeRow, PlanCard, ThoughtRow, ToolGroup, TypingDots, UserBubble } from "./Items";
import { PermissionCard } from "./Permission";

type Row = { key: string; item: TimelineItem } | { key: string; tools: ToolCallItem[] };

/** Consecutive tool calls are shown as one stacked card. */
function buildRows(items: TimelineItem[]): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    const last = rows[rows.length - 1];
    if (item.kind === "tool_call") {
      if (last && "tools" in last) last.tools.push(item);
      else rows.push({ key: item.id, tools: [item] });
    } else rows.push({ key: item.id, item });
  }
  return rows;
}

const PAGE = 120;

export function Timeline({
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
  const [limit, setLimit] = useState(PAGE);
  const hidden = Math.max(0, rows.length - limit);
  const visible = hidden ? rows.slice(hidden) : rows;
  const busy = isBusy(agent.status) && agent.status !== "needs_permission";
  const lastItem = items[items.length - 1];
  const streamingId =
    busy && !pending.length && lastItem && (lastItem.kind === "agent_message" || lastItem.kind === "thought") ? lastItem.id : null;
  const showWorking = busy && !streamingId;

  return (
    <div className="space-y-4">
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => {
            noteUserLayoutChange();
            setLimit((l) => l + PAGE);
          }}
          className="press mx-auto flex h-10 items-center rounded-full border border-line bg-panel px-4 text-[13px] font-medium text-muted"
        >
          Show {Math.min(PAGE, hidden)} earlier
        </button>
      )}
      {visible.map((row) => {
        if ("tools" in row) return <ToolGroup key={row.key} items={row.tools} />;
        const it = row.item;
        switch (it.kind) {
          case "user_message":
            return <UserBubble key={row.key} text={it.text} ts={it.ts} />;
          case "agent_message":
            return <AgentMessage key={row.key} item={it} streaming={it.id === streamingId} />;
          case "thought":
            return <ThoughtRow key={row.key} item={it} streaming={it.id === streamingId} />;
          case "permission":
            return <PermissionCard key={row.key} item={it} readOnly={readOnly} />;
          case "plan":
            return <PlanCard key={row.key} item={it} />;
          case "notice":
            return <NoticeRow key={row.key} item={it} />;
          default:
            return null; // item kinds from a newer desktop version
        }
      })}
      {pending.map((p) => (
        <UserBubble
          key={p.id}
          text={p.text}
          state={p.failed ? "failed" : "sending"}
          onRetry={() => void sendPrompt(agent.id, p.text, p.id)}
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
  );
}
