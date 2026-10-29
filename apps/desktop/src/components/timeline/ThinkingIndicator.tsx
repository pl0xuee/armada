import { useEffect, useRef, useState } from "react";
import type { Agent } from "@/lib/types";
import { useHeld, WAITING_HOLD_MS } from "@/hooks/useHeld";
import { useIdentity } from "@/hooks/useIdentity";
import { ProviderGlyph } from "../ProviderGlyph";
import { useRunningSubagentCount } from "../agent/useSubagents";
import { formatElapsed, THINKING_VERBS, waitingLabel } from "./thinking";

const VERB_MS = 3000;

/** Compact "the agent is busy" row, in the agent's voice. Sits below the conversation. */
export function ThinkingIndicator({ agent, since }: { agent: Agent; since: number }) {
  const name = useIdentity(agent.provider, agent.customAgentId).short;
  const subagents = useHeld(useRunningSubagentCount(agent.id), 0, WAITING_HOLD_MS);
  const starting = agent.status === "starting";
  const [verb, setVerb] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const offset = useRef(Math.floor(Math.random() * THINKING_VERBS.length));

  useEffect(() => {
    const t = setInterval(() => setVerb((v) => v + 1), VERB_MS);
    const c = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(t);
      clearInterval(c);
    };
  }, []);

  const label = starting
    ? `Starting ${name}`
    : subagents > 0
      ? waitingLabel(subagents)
      : THINKING_VERBS[(verb + offset.current) % THINKING_VERBS.length];
  const elapsed = now - since;

  return (
    <div role="status" aria-label={`${name} is working`} className="flex items-center gap-2.5 pb-2 pt-1">
      <span className="relative inline-flex h-6 w-6 shrink-0 items-center justify-center" aria-hidden>
        <span className="absolute inset-0 animate-spin-slow rounded-full border border-transparent border-t-accent/70" />
        <ProviderGlyph
          provider={agent.provider}
          customAgentId={agent.customAgentId}
          size="xs"
          className="animate-breathe"
        />
      </span>
      <span aria-hidden className="flex min-w-0 items-baseline gap-1.5 text-[12.5px]">
        <span key={label} className="think-text truncate">
          {label}
        </span>
        <span className="flex gap-[3px] self-center">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-[3px] w-[3px] animate-breathe rounded-full bg-steel"
              style={{ animationDelay: `${i * 0.25}s` }}
            />
          ))}
        </span>
        {elapsed >= 3000 && <span className="tabular text-2xs text-steel">· {formatElapsed(elapsed)}</span>}
      </span>
    </div>
  );
}
