import { Plus, Radar } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { EmptyState } from "@/components/EmptyState";
import { AgentRowCompact } from "@/components/mission/AgentRowCompact";
import { AgentTile } from "@/components/mission/AgentTile";
import { EMPTY_SUMMARY, useTileSummaries } from "@/components/mission/useTileSummaries";
import { LIVE, matchesFilter, type Filter } from "@/components/mission/useFleet";
import { Button } from "@/components/ui/button";
import type { Agent } from "@/lib/types";
import {
  useApp,
  usePendingPermissions,
  usePendingQuestions,
  type PendingPermission,
  type PendingQuestion,
} from "@/store/app";
import { useUi } from "@/store/ui";

export type Density = "comfortable" | "compact";

/** Above this many tiles a reorder just jumps: measuring every tile costs more than the glide is worth. */
const REORDER_ANIMATION_MAX = 30;
const REORDER_ANIMATION_MS = 240;
/** How stale the remembered tile positions may get while nothing reorders (tiles change height as they stream). */
const POSITION_REFRESH_MS = 300;

type Positions = Map<string, [number, number]>;

function measure(grid: HTMLElement): Positions {
  const out: Positions = new Map();
  for (const el of Array.from(grid.children) as HTMLElement[]) {
    if (el.dataset.tile) out.set(el.dataset.tile, [el.offsetLeft, el.offsetTop]);
  }
  return out;
}

/**
 * Slides tiles from where they were to where they are when `order` changes (an agent moved between
 * status groups). Positions are only read when the order changes and, at most every POSITION_REFRESH_MS,
 * in between: a layout animation on every tile measured all of them on every streamed token.
 */
function useReorderAnimation(grid: RefObject<HTMLElement | null>, order: string, enabled: boolean) {
  const last = useRef<Positions>(new Map());
  const refresh = useRef<number>(undefined);

  useLayoutEffect(() => {
    const el = grid.current;
    if (!el || !enabled) return;
    const now = measure(el);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduce) {
      for (const tile of Array.from(el.children) as HTMLElement[]) {
        const from = last.current.get(tile.dataset.tile ?? "");
        const to = now.get(tile.dataset.tile ?? "");
        if (!from || !to || (from[0] === to[0] && from[1] === to[1])) continue;
        tile.animate([{ transform: `translate(${from[0] - to[0]}px, ${from[1] - to[1]}px)` }, { transform: "none" }], {
          duration: REORDER_ANIMATION_MS,
          easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
        });
      }
    }
    last.current = now;
  }, [grid, order, enabled]);

  useEffect(() => {
    if (!enabled || refresh.current !== undefined) return;
    refresh.current = window.setTimeout(() => {
      refresh.current = undefined;
      if (grid.current) last.current = measure(grid.current);
    }, POSITION_REFRESH_MS);
  });
  useEffect(() => () => window.clearTimeout(refresh.current), []);
}

/** Mission Control's "All agents" tab: every agent as a live tile (or a dense row). */
export function AllAgentsPane({
  agents,
  filter,
  density,
  onClearFilter,
}: {
  agents: Agent[];
  filter: Filter;
  density: Density;
  onClearFilter: () => void;
}) {
  const pending = usePendingPermissions();
  const questions = usePendingQuestions();
  const summaries = useTileSummaries();
  const accounts = useApp((s) => s.accounts);
  const openAgent = useUi((s) => s.openAgent);
  const openNewAgent = useUi((s) => s.openNewAgent);

  const visible = useMemo(() => agents.filter((a) => matchesFilter(a, filter)), [agents, filter]);
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const pendingByAgent = useMemo(() => {
    const map = new Map<string, PendingPermission["item"]>();
    for (const p of pending) {
      if (!map.has(p.agent.id)) map.set(p.agent.id, p.item);
    }
    return map;
  }, [pending]);

  const questionByAgent = useMemo(() => {
    const map = new Map<string, PendingQuestion["item"]>();
    for (const p of questions) {
      if (!map.has(p.agent.id)) map.set(p.agent.id, p.item);
    }
    return map;
  }, [questions]);

  // Lazily load timelines for live agents so tiles can show their last action.
  const liveIds = agents
    .filter((a) => LIVE.includes(a.status))
    .map((a) => a.id)
    .join(",");
  useEffect(() => {
    if (!liveIds) return;
    const ensure = useApp.getState().ensureItems;
    for (const id of liveIds.split(",")) void ensure(id);
  }, [liveIds]);

  const grid = useRef<HTMLDivElement>(null);
  useReorderAnimation(grid, visible.map((a) => a.id).join(","), visible.length <= REORDER_ANIMATION_MAX);

  if (agents.length === 0) {
    return (
      <EmptyState
        className="my-auto"
        icon={<Radar />}
        title="Your fleet is docked"
        description="Launch an agent and it shows up here as a live tile: status, last action and approvals at a glance."
        action={
          <Button variant="primary" onClick={() => openNewAgent()}>
            <Plus /> New agent
          </Button>
        }
      />
    );
  }
  if (visible.length === 0) {
    return (
      <EmptyState
        className="my-auto"
        icon={<Radar />}
        title="All quiet on this channel"
        description="No agents match this filter right now."
        action={
          <Button variant="secondary" onClick={onClearFilter}>
            Show all agents
          </Button>
        }
      />
    );
  }
  if (density === "compact") {
    return (
      <div
        role="list"
        aria-label="Agents"
        className="@container overflow-hidden rounded-xl border border-line bg-card edge"
      >
        <div className="contents">
          {visible.map((a) => (
            <AgentRowCompact
              key={a.id}
              agent={a}
              account={accountMap.get(a.accountId)}
              summary={summaries.get(a.id) ?? EMPTY_SUMMARY}
              pending={pendingByAgent.get(a.id) ?? null}
              question={questionByAgent.get(a.id) ?? null}
              onOpen={openAgent}
            />
          ))}
        </div>
      </div>
    );
  }
  return (
    <div
      ref={grid}
      className="relative grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:[grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]"
    >
      <AnimatePresence initial={false}>
        {visible.map((a) => (
          <m.div
            key={a.id}
            data-tile={a.id}
            className="h-full"
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{
              duration: 0.16,
              ease: [0.2, 0.8, 0.2, 1],
            }}
          >
            <AgentTile
              agent={a}
              account={accountMap.get(a.accountId)}
              summary={summaries.get(a.id) ?? EMPTY_SUMMARY}
              pending={pendingByAgent.get(a.id) ?? null}
              question={questionByAgent.get(a.id) ?? null}
              onOpen={openAgent}
            />
          </m.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
