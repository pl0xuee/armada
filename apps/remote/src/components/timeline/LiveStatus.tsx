import { memo, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { plural } from "@/lib/format";
import { liveStep } from "@/lib/liveStep";
import { noteUserLayoutChange } from "@/lib/scroll";
import { inheritedConfig, subagentChips, type InheritedConfig, type RunningSubagent } from "@/lib/subagents";
import { ELAPSED_AFTER_MS, formatElapsed, VERB_MS } from "@/lib/thinking";
import type { Agent, TimelineItem } from "@/lib/types";
import { Icon } from "../Icon";
import { SubagentChips } from "./SubagentChips";
import { TypingDots } from "./Items";

/**
 * The one place that says what the agent is doing right now, under the last message: dots, the current
 * step in plain words ("Running `npm test`", "Reading foo.ts", "Writing…"), and the turn's elapsed time.
 * One fixed-height line, so a changing step never moves anything. While sub-agents run it reads
 * "Waiting on N sub-agents" and taps open a compact list of them.
 */
export const LiveStatus = memo(function LiveStatus({
  agent,
  name,
  items,
  subagents,
  running,
  since,
  open,
  onToggle,
}: {
  agent: Pick<Agent, "status" | "configOptions" | "model">;
  /** The agent's short name ("Claude"), for "Starting Claude". */
  name: string;
  items: readonly TimelineItem[];
  /** How many sub-agents the agent is waiting on. */
  subagents: number;
  /** The running ones, for the list. */
  running: readonly RunningSubagent[];
  /** Start of the turn (ms); 0: count from when this line appeared. */
  since: number;
  open: boolean;
  onToggle: () => void;
}) {
  const [tick, setTick] = useState(0);
  const mounted = useRef(Date.now());
  const offset = useRef(Math.floor(Math.random() * 8));
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  void tick;
  const now = Date.now();
  const step = liveStep(items, { starting: agent.status === "starting", name, subagents, verb: Math.floor((now - mounted.current) / VERB_MS), offset: offset.current });
  // Without a prompt in view (older messages not loaded) count from when the line appeared.
  const elapsed = now - (since || mounted.current);
  const expandable = subagents > 0 && running.length > 0;
  const line = (
    <>
      <TypingDots quiet />
      <span className="min-w-0 truncate">
        {step.text}
        {step.code && (
          <>
            {" "}
            <code className="font-mono text-[12.5px] text-muted">{step.code}</code>
          </>
        )}
      </span>
      {elapsed >= ELAPSED_AFTER_MS && <span className="shrink-0 text-[12px] tabular">· {formatElapsed(elapsed)}</span>}
    </>
  );

  return (
    <div role="status">
      {expandable ? (
        <button
          type="button"
          onClick={() => {
            noteUserLayoutChange();
            onToggle();
          }}
          aria-expanded={open}
          className="press-row hit relative -ml-1 flex h-9 w-[calc(100%+0.25rem)] items-center gap-2 rounded-xl pr-1 pl-1.5 text-left text-[13px] text-steel"
        >
          {line}
          <Icon name="chevronDown" size={16} className={cn("ml-auto shrink-0 text-steel/80 transition-transform duration-150", !open && "-rotate-90")} />
        </button>
      ) : (
        <div className="flex h-9 items-center gap-2 pl-0.5 text-[13px] text-steel">{line}</div>
      )}
      {open && expandable && <SubagentList running={running} now={now} inherited={inheritedConfig(agent)} />}
    </div>
  );
});

/** Each running sub-agent: kind and task, model / effort chips, time since launch and tool calls so far. */
export function SubagentList({ running, now, inherited }: { running: readonly RunningSubagent[]; now: number; inherited: InheritedConfig }) {
  return (
    <ul className="animate-fade mb-1 ml-[7px] space-y-2.5 border-l border-line pt-0.5 pl-3.5" aria-label="Running sub-agents">
      {running.map((s) => (
        <li key={s.id} className="min-w-0">
          <div className="flex min-w-0 items-baseline gap-1.5 text-[13px]">
            <span className="shrink-0 font-medium text-muted">{s.kind}</span>
            <span className="min-w-0 flex-1 truncate text-steel">{s.description}</span>
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-steel">
            <SubagentChips chips={subagentChips(s, inherited)} />
            <span className="tabular">
              {formatElapsed(now - s.startedAt)} · {plural(s.toolCalls, "tool call")}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
