import { describe, expect, it, vi } from "vitest";
import { selectFromAgents } from "./memoSelector";

describe("selectFromAgents", () => {
  it("recomputes only when the agents object changes", () => {
    const compute = vi.fn((a: Record<string, number>) => Object.keys(a).length);
    const select = selectFromAgents(compute);
    const agents = { a: 1, b: 2 };
    expect(select({ agents })).toBe(2);
    expect(select({ agents })).toBe(2);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(select({ agents: { ...agents, c: 3 } })).toBe(3);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("caches a result that is undefined or falsy", () => {
    const compute = vi.fn(() => 0);
    const select = selectFromAgents(compute);
    const agents = {};
    select({ agents });
    select({ agents });
    expect(compute).toHaveBeenCalledTimes(1);
  });
});
