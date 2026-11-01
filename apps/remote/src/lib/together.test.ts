import { describe, expect, it } from "vitest";
import { addRoom, buildAddRequests, clampCount, MAX_TOGETHER, siblingsOf, withGroup } from "./together";
import type { Agent } from "./types";

const agent = (id: string, extra: Partial<Agent> = {}) =>
  ({
    id,
    title: id,
    provider: "claude",
    accountId: "acc",
    projectPath: "/code/web",
    createdAt: Number(id.replace(/\D/g, "")) || 1,
    archived: false,
    groupId: null,
    ...extra,
  }) as Agent;

describe("add room and count", () => {
  it("allows up to 8 together, counting the agent you add from", () => {
    expect(MAX_TOGETHER).toBe(8);
    expect(addRoom(1)).toBe(7);
    expect(addRoom(0)).toBe(7);
    expect(addRoom(4)).toBe(4);
    expect(addRoom(8)).toBe(0);
    expect(addRoom(12)).toBe(0);
  });
  it("keeps the stepper inside 1..room", () => {
    expect(clampCount(0, 5)).toBe(1);
    expect(clampCount(9, 5)).toBe(5);
    expect(clampCount(3, 5)).toBe(3);
    expect(clampCount(3, 0)).toBe(1);
    expect(clampCount(NaN, 5)).toBe(1);
  });
});

describe("siblingsOf", () => {
  const list = [
    agent("a1", { groupId: "g" }),
    agent("a2", { groupId: "g" }),
    agent("a3", { groupId: "g", archived: true }),
    agent("a4"),
    agent("a5", { groupId: "h" }),
  ];
  it("lists the agents sharing a group, oldest first, without archived ones", () => {
    expect(siblingsOf(list, "a2").map((a) => a.id)).toEqual(["a1", "a2"]);
  });
  it("keeps the agent itself even when archived", () => {
    expect(siblingsOf(list, "a3").map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
  });
  it("is empty for an agent on its own", () => {
    expect(siblingsOf(list, "a4")).toEqual([]);
    expect(siblingsOf(list, "a5")).toEqual([]);
    expect(siblingsOf(list, "nope")).toEqual([]);
  });
  it("includes the agent you added from through the group this device remembers", () => {
    expect(siblingsOf(list, "a4", [["a4", "a5"]]).map((a) => a.id)).toEqual(["a4", "a5"]);
    expect(siblingsOf(list, "a5", [["a4", "a5"]]).map((a) => a.id)).toEqual(["a4", "a5"]);
  });
});

describe("buildAddRequests", () => {
  it("starts count copies of the same agent in the same project, each in a worktree, in one group", () => {
    const reqs = buildAddRequests(agent("a1"), "  Also write tests ", 3, "new-group");
    expect(reqs).toHaveLength(3);
    expect(reqs[0]).toEqual({
      provider: "claude",
      accountId: "acc",
      projectPath: "/code/web",
      worktree: true,
      groupId: "new-group",
      prompt: "Also write tests",
    });
    expect(new Set(reqs.map((r) => JSON.stringify(r))).size).toBe(1);
  });
  it("joins the agent's own group, and leaves the prompt out when empty", () => {
    const [r] = buildAddRequests(agent("a1", { groupId: "g", customAgentId: "gem" }), "   ", 1, "ignored");
    expect(r.groupId).toBe("g");
    expect(r.customAgentId).toBe("gem");
    expect("prompt" in r).toBe(false);
  });
});

describe("withGroup", () => {
  it("puts the newest group first and merges overlapping ones", () => {
    expect(
      withGroup(
        [
          ["a", "b"],
          ["x", "y"],
        ],
        ["b", "c"],
      ),
    ).toEqual([
      ["b", "c", "a"],
      ["x", "y"],
    ]);
  });
  it("keeps only the most recent groups", () => {
    let g: string[][] = [];
    for (let i = 0; i < 30; i++) g = withGroup(g, [`s${i}`, `t${i}`]);
    expect(g).toHaveLength(20);
    expect(g[0]).toEqual(["s29", "t29"]);
  });
});
