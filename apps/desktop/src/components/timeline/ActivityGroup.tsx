import { ChevronRight, CircleCheck, CircleX } from "lucide-react";
import { m, AnimatePresence } from "motion/react";
import { memo, useId } from "react";
import type { Agent, TimelineItem } from "@/lib/types";
import { pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Spinner } from "../ui/misc";
import { AgentMessage, ThoughtBlock, ToolCallCard } from "./items";

type ToolItem = Extract<TimelineItem, { kind: "tool_call" }>;

/** "Read 4 files, edited 2 files, ran 3 commands". */
export function summarizeActivity(items: TimelineItem[]): { text: string; failed: number } {
  let read = 0,
    edit = 0,
    run = 0,
    search = 0,
    fetch = 0,
    other = 0,
    failed = 0,
    tools = 0;
  for (const it of items) {
    if (it.kind !== "tool_call") continue;
    tools++;
    if (it.status === "failed") failed++;
    switch (it.toolKind) {
      case "read":
        read++;
        break;
      case "edit":
      case "delete":
      case "move":
        edit++;
        break;
      case "execute":
        run++;
        break;
      case "search":
        search++;
        break;
      case "fetch":
        fetch++;
        break;
      default:
        other++;
    }
  }
  const parts: string[] = [];
  if (read) parts.push(`read ${pluralize(read, "file")}`);
  if (edit) parts.push(`edited ${pluralize(edit, "file")}`);
  if (run) parts.push(`ran ${pluralize(run, "command")}`);
  if (search) parts.push(`${pluralize(search, "search", "searches")}`);
  if (fetch) parts.push(`${pluralize(fetch, "fetch", "fetches")}`);
  if (other) parts.push(`used ${pluralize(other, "other tool")}`);
  let text: string;
  if (tools === 0)
    text = items.some((i) => i.kind === "thought") ? "Thought for a moment" : pluralize(items.length, "step");
  else {
    text = parts.join(", ");
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }
  return { text, failed };
}

/**
 * A run of consecutive activity (tool calls, thoughts, interim messages) collapsed into one line.
 * Always its static summary (a spinner marks an unfinished one); what is happening right now is said
 * by the live status line under the conversation, never here. Expanded, it lists every step.
 */
export const ActivityGroup = memo(function ActivityGroup({
  items,
  agent,
  live,
  agentLive,
  open,
  onToggle,
  groupId,
}: {
  items: TimelineItem[];
  agent: Agent;
  /** The agent is working and this group holds the latest timeline item. */
  live: boolean;
  agentLive: boolean;
  open: boolean;
  onToggle: (groupId: string) => void;
  groupId: string;
}) {
  const bodyId = useId();
  const { text, failed } = summarizeActivity(items);

  return (
    <div>
      <button
        type="button"
        onClick={() => onToggle(groupId)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="group/trace -mx-1.5 flex h-7 w-[calc(100%+0.75rem)] items-center gap-2 rounded-lg px-1.5 text-left text-steel transition-colors hover:bg-raised/40 hover:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          {live ? (
            <Spinner className="h-3.5 w-3.5" />
          ) : failed > 0 ? (
            <CircleX className="h-3.5 w-3.5 text-err/80" aria-hidden />
          ) : (
            <CircleCheck className="h-3.5 w-3.5 text-ok/60" aria-hidden />
          )}
        </span>
        <span className={cn("min-w-0 truncate text-[12.5px]", live && "text-muted")} title={text}>
          {text}
        </span>
        {!live && failed > 0 && (
          <span className="shrink-0 text-[11.5px] text-err/90" aria-label={`${failed} failed`}>
            · {failed} failed
          </span>
        )}
        <span className="shrink-0 text-[11.5px] tabular-nums text-steel">· {pluralize(items.length, "step")}</span>
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 text-steel/70 transition-transform duration-150 group-hover/trace:text-muted",
            open && "rotate-90",
          )}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <m.div
            id={bodyId}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="pb-1 pt-1"
          >
            <div className="ml-[7px] space-y-1 border-l border-line pl-3">
              {items.map((it, i) => {
                const tail = live && i === items.length - 1;
                switch (it.kind) {
                  case "tool_call":
                    return (
                      <ToolCallCard key={it.id} item={it as ToolItem} agentId={agent.id} agentLive={agentLive} nested />
                    );
                  case "thought":
                    return <ThoughtBlock key={it.id} item={it} live={tail} agentId={agent.id} />;
                  case "agent_message":
                    return <AgentMessage key={it.id} item={it} agent={agent} interim streaming={tail} />;
                  default:
                    return null;
                }
              })}
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
});
