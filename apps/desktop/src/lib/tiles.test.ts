import { describe, expect, it } from "vitest";
import { idealTileColumns, MAX_TILES, tileGrid, tileIdsFor, tilePlacement, TILE_MIN_WIDTH } from "./helpers";
import type { Agent } from "./types";

const ag = (id: string, over: Partial<Agent> = {}): Agent =>
  ({ id, title: id, status: "idle", archived: false, parentId: null, createdAt: 1, ...over }) as Agent;
const byId = (...list: Agent[]) => Object.fromEntries(list.map((a) => [a.id, a]));

describe("idealTileColumns", () => {
  it("picks a shape that looks right for each count", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(idealTileColumns)).toEqual([1, 2, 3, 2, 3, 3, 4, 4]);
  });
});

describe("tileGrid", () => {
  it("one agent is one pane", () => {
    expect(tileGrid(1, 3000)).toEqual({ cols: 1, rows: 1 });
  });
  it("uses the ideal columns when they fit", () => {
    expect(tileGrid(4, 1500)).toEqual({ cols: 2, rows: 2 });
    expect(tileGrid(8, 1500)).toEqual({ cols: 4, rows: 2 });
    expect(tileGrid(5, 1500)).toEqual({ cols: 3, rows: 2 });
  });
  it("uses fewer columns when the width can't hold them", () => {
    expect(tileGrid(8, 3 * TILE_MIN_WIDTH)).toEqual({ cols: 3, rows: 3 });
    expect(tileGrid(8, 2 * TILE_MIN_WIDTH)).toEqual({ cols: 2, rows: 4 });
  });
  it("one column means the agents don't fit side by side", () => {
    expect(tileGrid(4, TILE_MIN_WIDTH + 100).cols).toBe(1);
    expect(tileGrid(3, 0).cols).toBe(1);
  });
});

describe("tilePlacement", () => {
  it("lays full rows out equally", () => {
    expect(tilePlacement(4, 2)).toEqual({
      units: 2,
      rows: 2,
      cells: [
        { row: 1, col: 1, span: 1 },
        { row: 1, col: 2, span: 1 },
        { row: 2, col: 1, span: 1 },
        { row: 2, col: 2, span: 1 },
      ],
    });
  });

  it("stretches a short last row to the full width", () => {
    // 5 in 3 columns: 3 on top, 2 below each taking half (on a track of 6).
    expect(tilePlacement(5, 3)).toEqual({
      units: 6,
      rows: 2,
      cells: [
        { row: 1, col: 1, span: 2 },
        { row: 1, col: 3, span: 2 },
        { row: 1, col: 5, span: 2 },
        { row: 2, col: 1, span: 3 },
        { row: 2, col: 4, span: 3 },
      ],
    });
  });

  for (let n = 1; n <= MAX_TILES; n++) {
    for (let cols = 1; cols <= 4; cols++) {
      it(`${n} agents in ${cols} columns: no overlaps, no holes, nothing outside the grid`, () => {
        const { units, rows, cells } = tilePlacement(n, cols);
        expect(cells).toHaveLength(n);
        expect(rows).toBe(Math.ceil(n / cols));
        const taken = new Set<string>();
        const perRow = new Map<number, number>();
        for (const c of cells) {
          expect(c.row).toBeGreaterThanOrEqual(1);
          expect(c.row).toBeLessThanOrEqual(rows);
          expect(c.col).toBeGreaterThanOrEqual(1);
          expect(c.col + c.span - 1).toBeLessThanOrEqual(units);
          for (let u = c.col; u < c.col + c.span; u++) {
            const key = `${c.row}:${u}`;
            expect(taken.has(key)).toBe(false);
            taken.add(key);
          }
          perRow.set(c.row, (perRow.get(c.row) ?? 0) + c.span);
        }
        // Every row, the last included, covers the whole width.
        for (let r = 1; r <= rows; r++) expect(perRow.get(r)).toBe(units);
        // Tiles stay in order: left to right, top to bottom.
        const order = cells.map((c) => c.row * (units + 1) + c.col);
        expect(order).toEqual([...order].sort((a, b) => a - b));
      });
    }
  }
});

describe("tileIdsFor", () => {
  const a = ag("a");
  const b = ag("b", { createdAt: 2 });
  const c = ag("c", { createdAt: 3 });

  it("is empty with nothing open or an unknown agent", () => {
    expect(tileIdsFor(byId(a), null, null, true)).toEqual([]);
    expect(tileIdsFor(byId(a), "zzz", null, true)).toEqual([]);
  });

  it("an explicit group wins, in its own order", () => {
    const h = ag("h", { parentId: "b", createdAt: 5 });
    expect(tileIdsFor(byId(a, b, c, h), "b", ["c", "a", "b"], true)).toEqual(["c", "a", "b"]);
  });

  it("ignores a group the open agent isn't in", () => {
    expect(tileIdsFor(byId(a, b, c), "c", ["a", "b"], true)).toEqual(["c"]);
  });

  it("drops archived and deleted agents from the group", () => {
    const old = ag("old", { archived: true });
    expect(tileIdsFor(byId(a, b, c, old), "a", ["a", "old", "gone", "b"], true)).toEqual(["a", "b"]);
  });

  it("keeps the open agent even when archived", () => {
    const old = ag("old", { archived: true });
    expect(tileIdsFor(byId(a, b, old), "old", ["a", "old", "b"], true)).toEqual(["a", "old", "b"]);
  });

  it("a group left with only the open agent is just that agent", () => {
    expect(tileIdsFor(byId(a, ag("x", { archived: true })), "a", ["a", "x"], false)).toEqual(["a"]);
  });

  it("falls back to a main agent and its helpers when tiling them is on", () => {
    const h1 = ag("h1", { parentId: "a", createdAt: 2 });
    const h2 = ag("h2", { parentId: "a", createdAt: 3 });
    const agents = byId(a, h1, h2, c);
    expect(tileIdsFor(agents, "a", null, true)).toEqual(["a", "h1", "h2"]);
    expect(tileIdsFor(agents, "h2", null, true)).toEqual(["a", "h1", "h2"]);
    expect(tileIdsFor(agents, "a", null, false)).toEqual(["a"]);
  });

  it("a plain agent is shown alone", () => {
    expect(tileIdsFor(byId(a, b), "a", null, true)).toEqual(["a"]);
  });
});
