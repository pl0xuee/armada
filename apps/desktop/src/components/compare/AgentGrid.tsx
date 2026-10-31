import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { CompareColumn } from "@/components/compare/CompareColumn";
import { ProviderGlyph } from "@/components/ProviderGlyph";
import { useNow } from "@/hooks/useNow";
import { identityFor } from "@/lib/identity";
import type { Agent } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";

/** Narrowest a column can be before the agents go behind tabs instead. */
const MIN_CELL = 300;
const GAP = 12;

/** Columns that look right for `n` agents: 2 → 2, 4 → 2×2, 5–6 → 3×2, 7+ → 4 wide. */
export function idealColumns(n: number): number {
  return n <= 3 ? n : n === 4 ? 2 : n <= 6 ? 3 : 4;
}

/** Agents of the same kind (e.g. four Claudes) get #1, #2… so they can be told apart. */
export function agentNumbers(agents: Agent[]): Map<string, string> {
  const kindOf = (a: Agent) => `${a.provider}|${a.customAgentId ?? ""}|${a.accountId}`;
  const totals = new Map<string, number>();
  for (const a of agents) totals.set(kindOf(a), (totals.get(kindOf(a)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const numbers = new Map<string, string>();
  for (const a of agents) {
    const k = kindOf(a);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if ((totals.get(k) ?? 0) > 1) numbers.set(a.id, `#${n}`);
  }
  return numbers;
}

/** Width of an element, kept up to date as the window or the panes around it resize. */
function useWidth() {
  // A callback ref, so it also works when the element only appears later (agents arriving).
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    // Measured before the first paint, so the grid doesn't flash as tabs.
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width] as const;
}

const isBusyStatus = (a: Agent) => a.status === "working" || a.status === "starting" || a.status === "needs_permission";

/**
 * Agents side by side in a grid that fits the space it is given: as many columns as fit (each at
 * least {@link MIN_CELL} wide), up to what looks right for that many agents; rows share the height
 * and only scroll when they can't keep a readable minimum. Too narrow for two columns, the agents
 * go behind tabs. Agents of the same kind are numbered #1, #2… so they can be told apart.
 */
export function AgentGrid({
  agents,
  onKeep,
  keepDisabled,
  selectedId,
  onSelect,
}: {
  agents: Agent[];
  /** Makes cards selectable (click a card, or its "Tell it something" button). */
  selectedId?: string | null;
  onSelect?: (a: Agent) => void;
  /** Shows "Keep this one" on each card (comparisons). */
  onKeep?: (a: Agent) => void;
  keepDisabled?: (a: Agent) => boolean;
}) {
  const items = useApp((s) => s.items);
  const accounts = useApp((s) => s.accounts);
  const customAgents = useApp((s) => s.settings?.customAgents);
  const openAgent = useUi((s) => s.openAgent);
  const now = useNow();
  const [areaRef, areaWidth] = useWidth();
  /** Column shown on narrow panes, where columns become tabs. */
  const [tabId, setTabId] = useState<string | null>(null);
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const ids = agents.map((a) => a.id).join(",");
  useEffect(() => {
    if (!ids) return;
    for (const id of ids.split(",")) void useApp.getState().ensureItems(id);
  }, [ids]);

  const costs = agents.map((a) => a.costUsd);
  const minCost = Math.min(...costs);
  // "Cheapest" only means something once every answer is in and the costs actually differ.
  const showCheapest = agents.length > 1 && !agents.some(isBusyStatus) && minCost < Math.max(...costs);
  const activeTab = agents.find((a) => a.id === tabId) ?? agents[0];
  const fit = Math.max(1, Math.floor((areaWidth + GAP) / (MIN_CELL + GAP)));
  const cols = Math.max(1, Math.min(fit, idealColumns(agents.length)));
  const tabbed = agents.length > 1 && cols < 2;
  const rows = Math.ceil(agents.length / cols);
  const minRow = agents.length > 3 ? 300 : 360;
  const numbers = agentNumbers(agents);
  if (!activeTab) return null;

  return (
    <div ref={areaRef} className="flex min-h-0 flex-1 flex-col gap-3">
      {tabbed && (
        <div
          role="tablist"
          aria-label="Agents in this comparison"
          onKeyDown={(e) =>
            tabKeys(
              e,
              agents.map((a) => a.id),
              activeTab.id,
              setTabId,
              "cmp-tab-",
            )
          }
          className="-mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {agents.map((a) => {
            const id = identityFor(a.provider, a.customAgentId, customAgents);
            const sel = a.id === activeTab.id;
            return (
              <button
                key={a.id}
                id={`cmp-tab-${a.id}`}
                type="button"
                role="tab"
                aria-selected={sel}
                tabIndex={sel ? 0 : -1}
                aria-controls={`cmp-col-${a.id}`}
                onClick={() => setTabId(a.id)}
                className={cn(
                  "flex h-9 min-w-0 flex-1 basis-0 items-center justify-center gap-2 rounded-lg border px-3 text-[12.5px] font-medium transition-colors",
                  sel
                    ? "border-line-strong bg-raised text-fg edge"
                    : "border-line/60 text-muted hover:bg-raised/60 hover:text-fg",
                  a.archived && "opacity-60",
                )}
              >
                <ProviderGlyph provider={a.provider} customAgentId={a.customAgentId} size="xs" />
                <span className="truncate">
                  {id.short}
                  {numbers.get(a.id) && <span className="ml-1 text-steel">{numbers.get(a.id)}</span>}
                </span>
                {a.status === "working" || a.status === "starting" ? (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent animate-breathe" aria-label="Working" />
                ) : showCheapest && a.costUsd === minCost ? (
                  <span className="hidden text-[10.5px] font-normal text-ok @md:inline">cheapest</span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
      <div className="-mx-1.5 -mt-1.5 min-h-0 flex-1 overflow-y-auto px-1.5 pb-1 pt-1.5">
        <div
          className="grid h-full gap-3"
          style={{
            gridTemplateColumns: `repeat(${tabbed ? 1 : cols}, minmax(0, 1fr))`,
            // A definite height, so rows share it equally instead of growing to their text; it only
            // grows (and the area scrolls) when the rows couldn't keep a readable minimum.
            gridTemplateRows: `repeat(${tabbed ? 1 : rows}, minmax(0, 1fr))`,
            minHeight: tabbed ? undefined : rows * minRow + (rows - 1) * GAP,
          }}
        >
          {agents.map((a) => (
            <div
              key={a.id}
              id={`cmp-col-${a.id}`}
              role={tabbed ? "tabpanel" : undefined}
              aria-labelledby={tabbed ? `cmp-tab-${a.id}` : undefined}
              tabIndex={onSelect ? 0 : undefined}
              aria-current={onSelect && a.id === selectedId ? "true" : undefined}
              onClick={
                onSelect
                  ? (e) => {
                      // Buttons, links and copy buttons inside the card keep their own meaning.
                      if ((e.target as HTMLElement).closest("a,button,[role=button]")) return;
                      onSelect(a);
                    }
                  : undefined
              }
              onKeyDown={
                onSelect
                  ? (e) => {
                      if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        onSelect(a);
                      }
                    }
                  : undefined
              }
              className={cn(
                "group relative flex min-h-0 min-w-0 rounded-xl outline-none",
                onSelect && "cursor-pointer",
                tabbed && a.id !== activeTab.id && "hidden",
                a.archived && "opacity-55",
              )}
            >
              <CompareColumn
                agent={a}
                account={accountMap.get(a.accountId)}
                items={items[a.id]}
                now={now}
                cheapest={showCheapest && a.costUsd === minCost}
                badge={numbers.get(a.id)}
                onOpen={() => openAgent(a.id)}
                onKeep={onKeep ? () => onKeep(a) : undefined}
                onSelect={onSelect ? () => onSelect(a) : undefined}
                selected={a.id === selectedId}
                keeping={keepDisabled?.(a) ?? false}
              />
              {onSelect && (
                // One outline on the card's own edge (inset, so the scroll area can't clip it), in place
                // of the status-coloured border while selected. Keyboard focus shows a fainter one.
                <span
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute inset-0 z-10 rounded-xl ring-inset transition-shadow",
                    a.id === selectedId
                      ? "ring-2 ring-accent"
                      : "group-focus-visible:ring-2 group-focus-visible:ring-accent/50",
                  )}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** WAI-ARIA tabs: ←/→ (wrapping), Home/End move the selection and focus. */
function tabKeys(
  e: React.KeyboardEvent<HTMLElement>,
  ids: string[],
  current: string,
  select: (id: string) => void,
  idPrefix: string,
) {
  const i = ids.indexOf(current);
  let next = -1;
  if (e.key === "ArrowRight") next = (i + 1) % ids.length;
  else if (e.key === "ArrowLeft") next = (i - 1 + ids.length) % ids.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = ids.length - 1;
  if (next < 0 || ids.length === 0) return;
  e.preventDefault();
  select(ids[next]);
  requestAnimationFrame(() => document.getElementById(`${idPrefix}${ids[next]}`)?.focus());
}
