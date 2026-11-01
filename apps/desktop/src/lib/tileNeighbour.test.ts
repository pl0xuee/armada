import { describe, expect, it } from "vitest";
import { tileNeighbour } from "./helpers";
import type { Agent } from "./types";

const ag = (id: string, over: Partial<Agent> = {}): Agent => ({ id, archived: false, ...over }) as Agent;
const byId = (...list: Agent[]) => Object.fromEntries(list.map((a) => [a.id, a]));

describe("tileNeighbour", () => {
  const all = byId(ag("a"), ag("b"), ag("c"));
  it("is the next agent in the group, else the previous", () => {
    expect(tileNeighbour(all, ["a", "b", "c"], "b")).toBe("c");
    expect(tileNeighbour(all, ["a", "b", "c"], "c")).toBe("b");
    expect(tileNeighbour(all, ["a", "b", "c"], "a")).toBe("b");
  });
  it("skips agents that are gone or archived, and the removed one itself", () => {
    const agents = byId(ag("a"), ag("b"), ag("c", { archived: true }));
    expect(tileNeighbour(agents, ["a", "x", "b", "c"], "a")).toBe("b");
    expect(tileNeighbour(agents, ["a", "b", "c"], "b")).toBe("a");
  });
  it("is null when nothing is left or the agent wasn't in the group", () => {
    expect(tileNeighbour(byId(ag("a")), ["a", "b"], "a")).toBeNull();
    expect(tileNeighbour(all, ["a", "b"], "c")).toBeNull();
    expect(tileNeighbour(all, null, "a")).toBeNull();
  });
});
