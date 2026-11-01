import { useMemo } from "react";
import { StatusDot } from "@/components/Identity";
import { Icon } from "@/components/Icon";
import { cn } from "@/lib/cn";
import { navigate } from "@/lib/router";
import { useStore } from "@/lib/store";
import { siblingsOf } from "@/lib/together";
import { useRememberedGroups } from "@/lib/togetherStore";
import { needsReason } from "@/lib/triage";
import { useScrollEdges } from "@/screens/AgentControls";
import type { Agent } from "@/lib/types";

/** The agents started together with this one (see `siblingsOf`). Empty when it is on its own. */
export function useSiblings(agentId: string): Agent[] {
  const agents = useStore((s) => s.agents);
  const groups = useRememberedGroups();
  return useMemo(() => siblingsOf(Object.values(agents), agentId, groups), [agents, groups, agentId]);
}

/**
 * Chips to hop between agents started together: a phone shows one conversation at a time, so instead of the
 * desktop's tile grid this is a swipeable row (status dot, number, title; the one you're on is lit; a dot says
 * which need you). Tapping one replaces this screen in the history, so Back still returns to the list.
 */
export function SiblingStrip({ agentId, onAdd }: { agentId: string; onAdd?: () => void }) {
  const siblings = useSiblings(agentId);
  const shown = siblings.length > 1;
  const { ref, edges } = useScrollEdges(shown);
  if (!shown) return null;
  return (
    <nav
      aria-label="Agents started together"
      ref={ref}
      className={cn(
        "scroll-x border-t border-line/60 [@media(orientation:landscape)_and_(max-height:500px)]:hidden",
        edges.left && edges.right ? "fade-x" : edges.right ? "fade-x-end" : edges.left ? "fade-x-start" : "",
      )}
    >
      <ul className="mx-auto flex w-max min-w-full items-center gap-1.5 px-safe py-1.5 md:w-full md:max-w-[860px]">
        {siblings.map((a, i) => {
          const current = a.id === agentId;
          const needs = needsReason(a) !== null && needsReason(a) !== "done";
          return (
            <li key={a.id} className="shrink-0">
              <button
                type="button"
                aria-current={current ? "page" : undefined}
                onClick={() => !current && navigate({ name: "agent", agentId: a.id }, { replace: true })}
                className={cn(
                  "press inline-flex h-11 max-w-[13rem] items-center gap-2 rounded-full border pr-3.5 pl-3 text-[13.5px]",
                  current ? "border-accent/55 bg-accent/10 font-semibold text-fg" : "border-line-strong bg-card text-muted",
                )}
              >
                <StatusDot status={a.status} size={8} />
                <span className="tabular text-steel">{i + 1}</span>
                <span className="min-w-0 truncate">{a.title}</span>
                {needs && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" role="img" aria-label="Needs you" />}
              </button>
            </li>
          );
        })}
        {onAdd && siblings.length < 8 && (
          <li className="shrink-0">
            <button
              type="button"
              onClick={onAdd}
              aria-label="Add agents"
              className="press inline-flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-line-strong text-muted"
            >
              <Icon name="plus" size={18} />
            </button>
          </li>
        )}
      </ul>
    </nav>
  );
}
