import { Bot, ChevronRight } from "lucide-react";
import { m, AnimatePresence } from "motion/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Agent, TimelineItem } from "@/lib/types";
import { pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useHeld, WAITING_HOLD_MS } from "@/hooks/useHeld";
import { useIdentity } from "@/hooks/useIdentity";
import { ProviderGlyph } from "../ProviderGlyph";
import { useRunningSubagentCount, useSubagentRuns } from "../agent/useSubagents";
import {
  formatElapsed,
  inheritedOf,
  liveStep,
  stepText,
  subagentChips,
  THINKING_VERBS,
  waitingLabel,
  type SubagentChip,
} from "./thinking";

const VERB_MS = 3000;

/** Model / effort chips, muted when they are only inherited from the main agent. */
export function SubagentChips({ chips, className }: { chips: SubagentChip[]; className?: string }) {
  if (chips.length === 0) return null;
  return (
    <>
      {chips.map((c) => (
        <span
          key={c.key}
          title={c.key === "model" ? "Model" : "Reasoning effort"}
          className={cn(
            "inline-flex h-4 shrink-0 items-center rounded border px-1 text-[10px] font-medium",
            c.inherited ? "border-line text-steel" : "border-line-strong bg-raised/60 text-muted",
            className,
          )}
        >
          {c.text}
        </span>
      ))}
    </>
  );
}

/**
 * The one place that says what a busy agent is doing right now, in the agent's voice. Sits at the
 * bottom-left under the last message: a small indicator plus a single fixed-height, truncated line
 * (the current step, "Waiting on N sub-agents", or cycling verbs). While sub-agents run it expands
 * into a compact list of them.
 */
export function LiveStatus({
  agent,
  items,
  since,
  messageSettled,
  open,
  onToggle,
}: {
  agent: Agent;
  items: readonly TimelineItem[];
  since: number;
  messageSettled: boolean;
  /** The sub-agent list is open (state lives in the timeline so it survives re-mounts). */
  open: boolean;
  onToggle: () => void;
}) {
  const name = useIdentity(agent.provider, agent.customAgentId).short;
  const subagents = useHeld(useRunningSubagentCount(agent.id), 0, WAITING_HOLD_MS);
  const runs = useSubagentRuns(agent.id);
  const running = useMemo(() => runs.filter((r) => r.state === "running"), [runs]);
  const inherited = useMemo(() => inheritedOf(agent.configOptions), [agent.configOptions]);
  const starting = agent.status === "starting";
  const [verb, setVerb] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const offset = useRef(Math.floor(Math.random() * THINKING_VERBS.length));
  const listId = useId();

  useEffect(() => {
    const t = setInterval(() => setVerb((v) => v + 1), VERB_MS);
    const c = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(t);
      clearInterval(c);
    };
  }, []);

  const step = starting || subagents > 0 ? null : liveStep(items, messageSettled);
  const cycling = !starting && subagents === 0 && !step;
  const label = starting
    ? `Starting ${name}`
    : subagents > 0
      ? waitingLabel(subagents)
      : step
        ? stepText(step)
        : THINKING_VERBS[(verb + offset.current) % THINKING_VERBS.length];
  const elapsed = now - since;
  const expandable = subagents > 0 && running.length > 0;
  const expanded = expandable && open;

  const text = (
    <span key={label} className="think-text min-w-0 truncate">
      {step?.mono && step.detail ? (
        <>
          {step.lead} <span className="font-mono text-[12px]">{step.detail}</span>
        </>
      ) : (
        label
      )}
    </span>
  );

  const line = (
    <>
      <span className="relative inline-flex h-6 w-6 shrink-0 items-center justify-center" aria-hidden>
        <span className="absolute inset-0 animate-spin-slow rounded-full border border-transparent border-t-accent/70" />
        <ProviderGlyph
          provider={agent.provider}
          customAgentId={agent.customAgentId}
          size="xs"
          className="animate-breathe"
        />
      </span>
      <span className="flex min-w-0 items-baseline gap-1.5 text-[12.5px]" title={label}>
        {text}
        {cycling && (
          <span className="flex gap-[3px] self-center" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-[3px] w-[3px] animate-breathe rounded-full bg-steel"
                style={{ animationDelay: `${i * 0.25}s` }}
              />
            ))}
          </span>
        )}
        {elapsed >= 3000 && <span className="tabular shrink-0 text-2xs text-steel">· {formatElapsed(elapsed)}</span>}
      </span>
      {expandable && (
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 text-steel/70 transition-transform duration-150", expanded && "rotate-90")}
          aria-hidden
        />
      )}
    </>
  );

  return (
    <div className="pb-2 pt-1">
      {/* Polite announcements of every step would be noise; LiveAnnouncer covers what matters. */}
      <div role="status" aria-live="off" aria-label={`${name} is working: ${label}`} className="h-7">
        {expandable ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={listId}
            className="-ml-1 flex h-7 max-w-full items-center gap-2.5 rounded-lg px-1 text-left text-muted transition-colors hover:bg-raised/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {line}
          </button>
        ) : (
          <div className="flex h-7 max-w-full items-center gap-2.5 text-muted">{line}</div>
        )}
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <m.ul
            id={listId}
            aria-label="Running sub-agents"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="ml-[11px] mt-1 space-y-0.5 border-l border-line pl-3"
          >
            {running.map((r) => (
              <li key={r.itemId} className="flex h-6 items-center gap-1.5 text-[12px]">
                <span className="inline-flex h-4 shrink-0 items-center gap-1 rounded border border-violet/30 bg-violet/10 px-1 text-[10px] font-semibold uppercase tracking-[0.05em] text-violet">
                  <Bot className="h-2.5 w-2.5" aria-hidden />
                  {r.kind ?? "Sub-agent"}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted" title={r.description}>
                  {r.description}
                </span>
                <SubagentChips chips={subagentChips(r, inherited)} />
                <span className="tabular shrink-0 text-[11px] text-steel">
                  {formatElapsed(now - r.startedAt)} · {pluralize(r.calls, "call")}
                </span>
              </li>
            ))}
          </m.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
