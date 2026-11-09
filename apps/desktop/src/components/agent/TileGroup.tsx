import { ChevronDown } from "lucide-react";
import { m } from "motion/react";
import { Fragment, startTransition, useEffect, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { planTiles, resizeTiles, TILE_MIN_WIDTH, tileGrid, tilePlacement } from "@/lib/helpers";
import { cn, modKey } from "@/lib/utils";
import { useElementWidth } from "@/hooks/useElementWidth";
import { useApp } from "@/store/app";
import { readTileWeights, saveTileWeights, useUi } from "@/store/ui";
import { StatusDot } from "../StatusDot";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/menu";

export interface TileContext {
  focused: boolean;
  /** More than one tile is on screen. */
  tiled: boolean;
  first: boolean;
  /** 1-based position among the agents shown together, to tell apart agents with the same title. */
  index?: number;
}

const KEY_STEP = 24;
/** Tiles appearing in one render, at or above this many, mount one at a time (a single helper spawning doesn't wait). */
const BULK_ARRIVAL = 3;
/** Shortest a row of the grid gets before the area scrolls instead. */
const MIN_ROW_HEIGHT = 340;

/**
 * Several agents' conversations at once (a main agent and its helpers, or agents started together).
 * `ids` has the main agent first. In a row of up to a few they sit side by side with draggable
 * dividers; more wrap into a grid whose last row stretches to fill the width. When two columns
 * don't fit at TILE_MIN_WIDTH, only the focused tile shows and the others go in a tab strip above.
 * With one id this is just a plain pane (same element structure, so the main tile survives a helper spawning).
 */
export function TileRow({
  ids,
  focusId,
  renderTile,
  onVisibleCount,
}: {
  ids: string[];
  focusId: string;
  /** Reports how many tiles are actually side by side (fewer than `ids` when some overflow). */
  onVisibleCount?: (n: number) => void;
  renderTile: (id: string, ctx: TileContext) => ReactNode;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const { cols, rows } = tileGrid(ids.length, width);
  const { visible, hidden } = planTiles(ids, focusId, cols >= 2 ? ids.length : 1);
  const mainId = ids[0];
  const idsKey = ids.join("\u0000");
  const [weights, setWeightsRaw] = useState<{ main: string; w: Record<string, number> }>(() => ({
    main: mainId,
    w: readTileWeights(mainId, ids),
  }));
  // A different main agent in the same slot loads its own saved weights.
  const current0 = weights.main === mainId ? weights.w : readTileWeights(mainId, ids);
  const setWeights = (f: (w: Record<string, number>) => Record<string, number>) =>
    setWeightsRaw((prev) => {
      const base = prev.main === mainId ? prev.w : readTileWeights(mainId, ids);
      const w = f(base);
      saveTileWeights(mainId, w);
      return { main: mainId, w };
    });
  // Drop weights of helpers that no longer exist.
  useEffect(() => {
    const live = new Set(idsKey.split("\u0000"));
    const stale = Object.keys(current0).some((id) => !live.has(id));
    if (stale || weights.main !== mainId) {
      const w = Object.fromEntries(Object.entries(current0).filter(([id]) => live.has(id)));
      saveTileWeights(mainId, w);
      setWeightsRaw({ main: mainId, w });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);
  const weightsMap = current0;
  const known = visible.map((id) => weightsMap[id]).filter((w): w is number => w !== undefined);
  const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const weightOf = (id: string) => weightsMap[id] ?? fallback;
  const cells = useRef<(HTMLDivElement | null)[]>([]);
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ x: number; widths: number[] }>({ x: 0, widths: [] });
  // Tiles that arrive after the group is on screen slide in; the first render doesn't animate.
  const seen = useRef<Set<string> | null>(null);
  const fresh = seen.current ? visible.filter((id) => !seen.current!.has(id)) : [];
  useEffect(() => {
    seen.current = new Set(visible);
  });

  const visibleCount = visible.length;
  useEffect(() => onVisibleCount?.(visibleCount), [visibleCount, onVisibleCount]);

  // Opening a big group: every conversation (header, timeline, composer) mounting in one commit is a
  // multi-hundred-millisecond freeze on a slow machine. The layout is final at once, but tiles that arrive
  // together fill in one per frame (the focused one first, and any tile you click at once).
  const [shownBefore, setShownBefore] = useState<ReadonlySet<string>>(() => new Set(visible));
  const [queued, setQueued] = useState<readonly string[]>([]);
  const arrivals = visible.filter((id) => !shownBefore.has(id));
  if (arrivals.length > 0) {
    // Set during render, so the first commit already has the placeholders.
    setShownBefore(new Set([...shownBefore, ...arrivals]));
    if (arrivals.length >= BULK_ARRIVAL)
      setQueued((q) => [...new Set([...q, ...arrivals.filter((id) => id !== focusId)])]);
  }
  const pending = queued.length > 0 ? queued[0] : null;
  useEffect(() => {
    if (pending === null) return;
    const frame = requestAnimationFrame(() =>
      startTransition(() => setQueued((q) => q.filter((id, i) => i > 0 && visible.includes(id)))),
    );
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, idsKey]);

  // The widths just applied by a drag: the separators read these instead of measuring on every move.
  const dragWidths = useRef<number[]>([]);
  const applyWidths = (next: number[]) => {
    dragWidths.current = next;
    setWeights((w) => ({ ...w, ...Object.fromEntries(visible.map((id, i) => [id, next[i]])) }));
  };
  const current = () => cells.current.slice(0, visible.length).map((el) => el?.getBoundingClientRect().width ?? 0);

  // Ctrl/⌘+Alt+←/→ moves focus between tiles (hidden ones included: they swap in).
  useEffect(() => {
    if (ids.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || !(e.ctrlKey || e.metaKey) || !e.altKey || e.shiftKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const i = Math.max(0, ids.indexOf(focusId));
      const next = ids[(i + (e.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length];
      useUi.getState().openAgent(next);
      useUi.getState().focusComposer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ids, focusId]);

  // Rows of tiles with draggable dividers, or (more than one row) a grid whose last row stretches to
  // fill the width. Both are the same element tree, so a conversation is never remounted when a
  // resize or a side panel moves the layout from one to the other.
  const gridded = visible.length > 1 && rows > 1;
  const { units, cells: placed } = tilePlacement(visible.length, cols);

  return (
    <div ref={ref} className="flex min-h-0 flex-1 flex-col">
      {hidden.length > 0 && <OverflowStrip hidden={hidden} />}
      <div className={cn("min-h-0 flex-1", gridded && "overflow-y-auto")}>
        <div
          className={cn(gridded ? "grid gap-px bg-line" : "flex min-h-0", drag !== null && "select-none")}
          style={
            gridded
              ? {
                  // A definite height, so the rows share it equally instead of growing to their content;
                  // it only exceeds the area (which then scrolls) when the rows couldn't keep a readable minimum.
                  height: "100%",
                  minHeight: rows * MIN_ROW_HEIGHT + (rows - 1),
                  gridTemplateColumns: `repeat(${units}, minmax(0, 1fr))`,
                  gridTemplateRows: `repeat(${rows}, minmax(${MIN_ROW_HEIGHT}px, 1fr))`,
                }
              : { height: "100%" }
          }
        >
          {visible.map((id, i) => (
            <Fragment key={id}>
              {!gridded && i > 0 && (
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize tiles"
                  aria-valuemin={TILE_MIN_WIDTH}
                  aria-valuemax={Math.round(
                    drag !== null
                      ? (dragWidths.current[i - 1] ?? 0) + (dragWidths.current[i] ?? 0) - TILE_MIN_WIDTH
                      : (cells.current[i - 1]?.getBoundingClientRect().width ?? 0) +
                          (cells.current[i]?.getBoundingClientRect().width ?? 0) -
                          TILE_MIN_WIDTH,
                  )}
                  aria-valuenow={Math.round(
                    drag !== null
                      ? (dragWidths.current[i - 1] ?? 0)
                      : (cells.current[i - 1]?.getBoundingClientRect().width ?? 0),
                  )}
                  tabIndex={0}
                  className="group/div relative z-10 w-px shrink-0 cursor-col-resize touch-none bg-line outline-none"
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    start.current = { x: e.clientX, widths: current() };
                    dragWidths.current = start.current.widths;
                    setDrag(i - 1);
                  }}
                  onPointerMove={(e) => {
                    if (drag === i - 1)
                      applyWidths(resizeTiles(start.current.widths, i - 1, e.clientX - start.current.x));
                  }}
                  onPointerUp={() => setDrag(null)}
                  onPointerCancel={() => setDrag(null)}
                  onDoubleClick={() => setWeights(() => ({}))}
                  onKeyDown={(e) => {
                    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                    e.preventDefault();
                    const step = (e.shiftKey ? 4 : 1) * KEY_STEP * (e.key === "ArrowLeft" ? -1 : 1);
                    applyWidths(resizeTiles(current(), i - 1, step));
                  }}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "absolute inset-y-0 -left-1 w-2 transition-colors group-hover/div:bg-accent/30 group-focus-visible/div:bg-accent/40",
                      drag === i - 1 && "bg-accent/40",
                    )}
                  />
                </div>
              )}
              <m.div
                ref={(el) => {
                  cells.current[i] = el;
                }}
                initial={fresh.includes(id) ? (gridded ? { opacity: 0, scale: 0.96 } : { opacity: 0, x: 28 }) : false}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                transition={{ type: "spring", stiffness: 380, damping: 34 }}
                className={cn(
                  "flex min-h-0 min-w-0 flex-col",
                  gridded && "bg-base",
                  !gridded && drag !== null && "pointer-events-none",
                )}
                style={
                  gridded
                    ? { gridRow: placed[i].row, gridColumn: `${placed[i].col} / span ${placed[i].span}` }
                    : {
                        flexGrow: weightOf(id),
                        flexShrink: 1,
                        flexBasis: 0,
                        minWidth: visible.length > 1 ? Math.min(TILE_MIN_WIDTH, width / visible.length) : 0,
                      }
                }
              >
                {id !== focusId && queued.includes(id) ? (
                  <TilePlaceholder id={id} />
                ) : (
                  renderTile(id, {
                    focused: id === focusId,
                    tiled: visible.length > 1,
                    first: i === 0,
                    index: ids.indexOf(id) + 1,
                  })
                )}
              </m.div>
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Holds a tile's place (same cell, so nothing moves when it fills in) until its turn to mount. */
function TilePlaceholder({ id }: { id: string }) {
  return (
    <div
      aria-hidden
      className="h-full min-h-0 flex-1 bg-base"
      onPointerDownCapture={() => useUi.getState().openAgent(id)}
    />
  );
}

/** Tabs for helpers that don't fit beside the others; choosing one swaps it in. */
function OverflowStrip({ hidden }: { hidden: string[] }) {
  const rows = useApp(
    useShallow((s) =>
      hidden.flatMap((id) => (s.agents[id] ? [`${id}\u0000${s.agents[id].title}\u0000${s.agents[id].status}`] : [])),
    ),
  ).map((r) => {
    const [id, title, status] = r.split("\u0000");
    return { id, title, status: status as never };
  });
  const open = (id: string) => {
    useUi.getState().openAgent(id);
    useUi.getState().focusComposer();
  };
  const tabs = rows.slice(0, rows.length > 3 ? 2 : 3);
  const more = rows.slice(tabs.length);
  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line bg-panel/50 px-3 text-caption">
      <span className="shrink-0 text-steel">Also open:</span>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => open(t.id)}
          className="inline-flex h-6 min-w-0 max-w-[200px] items-center gap-1.5 rounded-full border border-line bg-card/60 px-2 text-muted transition-colors hover:border-line-strong hover:text-fg"
        >
          <StatusDot status={t.status} size={6} />
          <span className="truncate">{t.title}</span>
        </button>
      ))}
      {more.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-line bg-card/60 px-2 text-muted transition-colors hover:border-line-strong hover:text-fg"
            >
              +{more.length} more <ChevronDown className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {more.map((t) => (
              <DropdownMenuItem key={t.id} onSelect={() => open(t.id)}>
                <StatusDot status={t.status} size={6} /> <span className="max-w-[260px] truncate">{t.title}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <span className="ml-auto hidden shrink-0 text-steel xl:inline">{modKey}+Alt+←/→ switches tile</span>
    </div>
  );
}
