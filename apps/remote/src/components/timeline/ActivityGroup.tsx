import { memo, useId, useMemo } from "react";
import { cn } from "@/lib/cn";
import { currentStep, summarizeActivity } from "@/lib/activity";
import { plural } from "@/lib/format";
import { noteUserLayoutChange } from "@/lib/scroll";
import type { TimelineItem, ToolCallItem } from "@/lib/types";
import { Icon, Spinner } from "../Icon";
import { AgentMessage, ThoughtRow, ToolGroup } from "./Items";

/** Tool calls that follow each other render as one card; thoughts and messages between them stand alone. */
type Segment = { kind: "tools"; key: string; tools: ToolCallItem[] } | { kind: "item"; key: string; item: TimelineItem };

export function segments(items: TimelineItem[]): Segment[] {
  const out: Segment[] = [];
  for (const it of items) {
    if (it.kind === "tool_call") {
      const last = out[out.length - 1];
      if (last?.kind === "tools") last.tools.push(it);
      else out.push({ kind: "tools", key: it.id, tools: [it] });
    } else out.push({ kind: "item", key: it.id, item: it });
  }
  return out;
}

/**
 * A run of tool calls, thoughts and interim messages folded into one tappable line
 * ("Read 4 files, edited 2 files, ran 3 commands"); tapping expands it in place. While the agent
 * works on it, the line shows the current step instead of the summary.
 */
export const ActivityGroup = memo(function ActivityGroup({
  items,
  live,
  agentLive,
  open,
  onToggle,
  groupId,
}: {
  items: TimelineItem[];
  /** The agent is working and this group holds the latest timeline item. */
  live: boolean;
  /** False when the agent isn't running (interrupted / stopped): unfinished calls show as paused. */
  agentLive: boolean;
  open: boolean;
  onToggle: (groupId: string) => void;
  groupId: string;
}) {
  const bodyId = useId();
  const summary = useMemo(() => summarizeActivity(items), [items]);
  const last = items[items.length - 1];
  const step = live ? currentStep(last) : null;
  const text = step?.text ?? summary.text;
  const failed = summary.failed;
  const body = useMemo(() => (open ? segments(items) : []), [open, items]);

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          noteUserLayoutChange();
          onToggle(groupId);
        }}
        aria-expanded={open}
        aria-controls={bodyId}
        className="press-row -mx-1 flex min-h-11 w-[calc(100%+0.5rem)] items-center gap-2 rounded-xl px-1 text-left text-steel"
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {live ? (
            <Spinner size={14} className="text-accent" />
          ) : (
            // Always a check: a finished run that had a failed command (usually re-run and passed) must not read
            // as "the turn failed". The count of failures stays in red in the text.
            <Icon name="check" size={15} strokeWidth={2.4} className={failed > 0 ? "text-steel" : "text-ok/70"} />
          )}
        </span>
        <span
          className={cn(
            "line-clamp-2 min-w-0 flex-1 py-1.5 text-[13.5px] leading-snug",
            live ? "text-muted" : "text-steel",
            step?.kind === "tool" && last?.kind === "tool_call" && last.toolKind === "execute" && "font-mono text-[12.5px]",
          )}
        >
          {text}
          {!live && failed > 0 && <span className="text-[12px] text-err/90"> · {failed} failed</span>}
          <span className="text-[12px] tabular"> · {plural(items.length, "step")}</span>
        </span>
        <Icon name="chevronDown" size={16} className={cn("shrink-0 text-steel/80 transition-transform duration-150", !open && "-rotate-90")} />
      </button>
      {open && (
        <div id={bodyId} className="animate-fade pt-1 pb-0.5">
          <div className="ml-[7px] space-y-2 border-l border-line pl-3.5">
            {body.map((seg) =>
              seg.kind === "tools" ? (
                <ToolGroup key={seg.key} items={seg.tools} agentLive={agentLive} />
              ) : seg.item.kind === "thought" ? (
                <ThoughtRow key={seg.key} item={seg.item} streaming={live && seg.item === last} />
              ) : seg.item.kind === "agent_message" ? (
                <AgentMessage key={seg.key} item={seg.item} streaming={live && seg.item === last} interim />
              ) : null,
            )}
          </div>
        </div>
      )}
    </div>
  );
});
