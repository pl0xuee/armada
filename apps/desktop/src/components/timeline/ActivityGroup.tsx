import { Brain, ChevronRight, CircleCheck, CircleX, MessageSquare } from "lucide-react";
import { m, AnimatePresence } from "motion/react";
import { memo, useId } from "react";
import type { Agent, TimelineItem } from "@/lib/types";
import { pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Spinner } from "../ui/misc";
import { AgentMessage, TOOL_ICON, ThoughtBlock, ToolCallCard } from "./items";

type ToolItem = Extract<TimelineItem, { kind: "tool_call" }>;

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.replace(/[*_`#>]/g, "").trim())
      .find(Boolean) ?? ""
  );
}

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
 * While live it shows the current step; expanded it lists every step.
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
  const last = items[items.length - 1];
  const summary = live ? null : summarizeActivity(items);
  const failed = items.filter((i) => i.kind === "tool_call" && i.status === "failed").length;

  let Icon: React.ComponentType<{ className?: string }> = CircleCheck;
  let text = summary?.text ?? "";
  let mono = false;
  if (live && last) {
    if (last.kind === "tool_call") {
      Icon = TOOL_ICON[last.toolKind];
      text = last.title;
      mono = last.toolKind === "execute";
    } else if (last.kind === "thought") {
      Icon = Brain;
      text = "Thinking…";
    } else if (last.kind === "agent_message") {
      Icon = MessageSquare;
      text = firstLine(last.text) || "Writing…";
    }
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-card/70 transition-colors focus-within:border-line-strong",
        open ? "border-line-strong" : "border-line hover:border-line-strong",
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(groupId)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex h-9 w-full items-center gap-2.5 px-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
      >
        <span
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line bg-raised text-steel",
            live && "border-accent/30 text-accent",
          )}
        >
          {live ? <Spinner className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5 text-ok/80" />}
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-[12.5px] text-fg/90", mono && "font-mono text-[12px]")}>
          {text}
        </span>
        {failed > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-err">
            <CircleX className="h-3.5 w-3.5" aria-hidden />
            <span aria-label={`${failed} failed`}>{failed}</span>
          </span>
        )}
        <span className="shrink-0 text-[11.5px] tabular-nums text-steel">{pluralize(items.length, "step")}</span>
        <ChevronRight
          className={cn("h-3.5 w-3.5 shrink-0 text-steel transition-transform duration-150", open && "rotate-90")}
        />
      </button>
      {live && !open && <div className="shimmer-bar h-px bg-accent/10" />}
      <AnimatePresence initial={false}>
        {open && (
          <m.div
            id={bodyId}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="border-t border-line px-2.5 py-2.5"
          >
            <div className="ml-[7px] space-y-2 border-l border-line-strong pl-3.5">
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
                    return <AgentMessage key={it.id} item={it} agent={agent} showHeader={false} streaming={tail} />;
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
