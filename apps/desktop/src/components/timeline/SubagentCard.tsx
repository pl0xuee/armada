import { Bot, ChevronDown, ChevronRight, CircleCheck, CirclePause, CircleX, ScrollText } from "lucide-react";
import { m, AnimatePresence } from "motion/react";
import { memo, useId, useMemo, useState } from "react";
import type { TimelineItem } from "@/lib/types";
import { pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { Markdown } from "../Markdown";
import { Spinner } from "../ui/misc";
import { TOOL_ICON, ToolCallCard } from "./items";
import { SubagentChips } from "./LiveStatus";
import { inheritedOf, subagentChips } from "./thinking";

type ToolItem = Extract<TimelineItem, { kind: "tool_call" }>;

/**
 * A tool call that ran a sub-agent (Claude Task, etc.): kind badge, description,
 * collapsed prompt, result, and its own tool calls nested underneath.
 */
/** Sub-agents can spawn sub-agents; deeper levels render as plain rows (cycle guard). */
const MAX_DEPTH = 6;
const NO_CHILDREN: ToolItem[] = [];

export const SubagentCard = memo(function SubagentCard({
  item,
  childrenOf,
  agentId,
  agentLive,
  bgRunning = false,
  depth = 0,
}: {
  item: ToolItem;
  /** Child calls per sub-agent toolCallId (all levels), resolved by the timeline. */
  childrenOf: Map<string, ToolItem[]>;
  agentId: string;
  agentLive: boolean;
  /** Background sub-agent that already returned its launch result but is still running. */
  bgRunning?: boolean;
  depth?: number;
}) {
  const childCalls = childrenOf.get(item.toolCallId) ?? NO_CHILDREN;
  const info = item.subagent ?? {};
  const unfinished = item.status === "in_progress" || item.status === "pending";
  const running = (unfinished && agentLive) || bgRunning;
  const stalled = unfinished && !agentLive;
  const failed = item.status === "failed";
  const [showPrompt, setShowPrompt] = useState(false);
  const [showChildren, setShowChildren] = useState(false);
  const childrenId = useId();
  const promptId = useId();
  const kind = info.kind?.trim() || "Sub-agent";
  const description = info.description?.trim() || null;
  const title = description ?? item.title;
  const configOptions = useApp((st) => st.agents[agentId]?.configOptions);
  const chips = useMemo(() => subagentChips(info, inheritedOf(configOptions)), [info, configOptions]);
  const latest = childCalls[childCalls.length - 1];
  const childrenRunning = childCalls.filter((c) => c.status === "in_progress" || c.status === "pending").length;

  return (
    <section
      aria-label={`${kind} sub-agent: ${title}`}
      className={cn(
        "relative overflow-hidden rounded-xl border bg-card/50",
        running ? "border-accent/30" : failed ? "border-err/30" : "border-line",
      )}
    >
      {running && <div aria-hidden className="shimmer-bar absolute inset-x-0 top-0 h-px" />}
      <header className="flex items-start gap-2.5 px-3 pb-2 pt-2.5">
        <span
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border",
            running ? "border-accent/40 bg-accent/10 text-accent" : "border-line-strong bg-raised text-steel",
          )}
        >
          <Bot className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-flex h-5 items-center rounded-md border border-violet/30 bg-violet/10 px-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-violet">
              {kind}
            </span>
            <SubagentChips chips={chips} />
            <span className="text-[11.5px] text-steel tabular">{pluralize(childCalls.length, "tool call")}</span>
            {bgRunning && <span className="text-[11.5px] text-accent">Running in background</span>}
            {running && childrenRunning > 0 && (
              <span className="text-[11.5px] text-accent tabular">{childrenRunning} running</span>
            )}
          </div>
          <p className="mt-1 break-words text-[13px] font-medium leading-snug text-fg">{title}</p>
          {description && item.title && item.title !== description && (
            <p className="mt-0.5 truncate text-[11.5px] text-steel" title={item.title}>
              {item.title}
            </p>
          )}
        </div>
        <span className="mt-1 shrink-0" aria-live="off">
          {stalled ? (
            <CirclePause className="h-4 w-4 text-violet" aria-label="Paused" />
          ) : running || unfinished ? (
            <Spinner className="h-4 w-4" />
          ) : failed ? (
            <CircleX className="h-4 w-4 text-err" aria-label="Failed" />
          ) : (
            <CircleCheck className="h-4 w-4 text-ok/80" aria-label="Done" />
          )}
        </span>
      </header>

      {info.prompt && (
        <div className="px-3 pb-2">
          <button
            type="button"
            aria-expanded={showPrompt}
            aria-controls={promptId}
            onClick={() => setShowPrompt((v) => !v)}
            className="-ml-1 inline-flex h-6 items-center gap-1 rounded-md px-1 text-[11.5px] text-muted transition-colors hover:text-fg focus-visible:outline-2"
          >
            <ScrollText className="h-3.5 w-3.5" />
            {showPrompt ? "Hide prompt" : "Show prompt"}
            <ChevronDown className={cn("h-3 w-3 transition-transform duration-150", showPrompt && "rotate-180")} />
          </button>
          <AnimatePresence initial={false}>
            {showPrompt && (
              <m.div
                id={promptId}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.12 }}
                className="mt-1 max-h-60 overflow-y-auto rounded-lg border border-line bg-base/50 px-3 py-2"
              >
                <Markdown text={info.prompt} className="!text-[12.5px] text-muted" />
              </m.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {childCalls.length > 0 && (
        <div className="border-t border-line">
          {running && !showChildren && latest ? <LatestChild item={latest} /> : null}
          <button
            type="button"
            aria-expanded={showChildren}
            aria-controls={childrenId}
            onClick={() => setShowChildren((v) => !v)}
            className="flex h-8 w-full items-center gap-1.5 px-3 text-left text-[11.5px] text-muted transition-colors hover:bg-raised/40 hover:text-fg"
          >
            <ChevronRight className={cn("h-3 w-3 transition-transform duration-150", showChildren && "rotate-90")} />
            {showChildren ? "Hide tool calls" : `Show all ${childCalls.length}`}
          </button>
          {showChildren && (
            <div id={childrenId} className="ml-[22px] space-y-1.5 border-l border-line-strong py-1.5 pl-3 pr-3">
              {childCalls.map((c) =>
                c.subagent && depth < MAX_DEPTH ? (
                  <SubagentCard
                    key={c.id}
                    item={c}
                    childrenOf={childrenOf}
                    agentId={agentId}
                    agentLive={agentLive}
                    depth={depth + 1}
                  />
                ) : (
                  <ToolCallCard key={c.id} item={c} agentId={agentId} agentLive={agentLive} nested />
                ),
              )}
            </div>
          )}
        </div>
      )}

      {!unfinished && !bgRunning && item.output.trim() && (
        <div className="border-t border-line bg-base/30 px-3 py-2.5">
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-steel">Result</div>
          <Markdown text={item.output} className="!text-[12.5px]" />
        </div>
      )}
    </section>
  );
});

function LatestChild({ item }: { item: ToolItem }) {
  const Icon = TOOL_ICON[item.toolKind];
  const running = item.status === "in_progress" || item.status === "pending";
  return (
    <div className="flex h-8 items-center gap-2 border-b border-line/60 px-3 text-[12px]" aria-live="polite">
      <span className="ml-[22px] h-full w-px bg-line-strong" aria-hidden />
      <Icon className="h-3.5 w-3.5 shrink-0 text-steel" />
      <span className={cn("min-w-0 flex-1 truncate", running ? "text-fg/90" : "text-muted")}>{item.title}</span>
      {running ? (
        <Spinner className="h-3.5 w-3.5" />
      ) : (
        <CircleCheck className="h-3.5 w-3.5 text-ok/70" aria-label="Done" />
      )}
    </div>
  );
}
