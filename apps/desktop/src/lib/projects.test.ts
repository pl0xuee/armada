import { describe, expect, it } from "vitest";
import { groupByProject, orderedAgents, projectKey, triageQueue } from "./agents";
import type { Agent } from "./types";

let n = 0;
const agent = (over: Partial<Agent>): Agent =>
  ({
    id: `a${++n}`,
    title: "t",
    projectPath: "/work/app",
    status: "idle",
    archived: false,
    pendingPermissions: 0,
    unread: false,
    rateLimited: false,
    acknowledgedAt: null,
    lastActivityAt: 0,
    branch: null,
    lastMessage: null,
    ...over,
  }) as Agent;

describe("groupByProject", () => {
  it("makes one group per folder, ignoring trailing slashes", () => {
    const { projects } = groupByProject([
      agent({ projectPath: "/work/app" }),
      agent({ projectPath: "/work/app/" }),
      agent({ projectPath: "/work/api" }),
    ]);
    expect(projects.map((p) => [p.name, p.agents.length]).sort()).toEqual([
      ["api", 1],
      ["app", 2],
    ]);
    expect(projectKey("C:\\work\\app\\")).toBe("C:\\work\\app");
  });

  it("puts projects that need you first, then the most recently active", () => {
    const { projects } = groupByProject([
      agent({ projectPath: "/a", lastActivityAt: 300 }),
      agent({ projectPath: "/b", lastActivityAt: 100, status: "needs_permission" }),
      agent({ projectPath: "/c", lastActivityAt: 200 }),
    ]);
    expect(projects.map((p) => p.name)).toEqual(["b", "a", "c"]);
    expect(projects[0].needs).toBe(1);
  });

  it("counts what needs you the way the rail badge does", () => {
    const { projects } = groupByProject([
      agent({ status: "needs_permission" }),
      agent({ status: "idle", pendingPermissions: 2 }),
      agent({ status: "error", lastActivityAt: 10, acknowledgedAt: 10 }), // marked Done
      agent({ status: "idle", unread: true }), // finished, not looked at
      agent({ status: "idle" }),
      agent({ status: "interrupted" }), // not waiting on you by itself
    ]);
    expect(projects[0].needs).toBe(3);
    expect(projects[0].needs).toBe(triageQueue(projects[0].agents).length);
  });

  it("brings an acknowledged agent back when it does something new", () => {
    const a = agent({ status: "error", lastActivityAt: 10, acknowledgedAt: 10 });
    expect(groupByProject([a]).projects[0].needs).toBe(0);
    expect(groupByProject([{ ...a, lastActivityAt: 11 }]).projects[0].needs).toBe(1);
  });

  it("orders a project's agents: needs you, working, then recent", () => {
    const { projects } = groupByProject([
      agent({ id: "idle", lastActivityAt: 900 }),
      agent({ id: "work", status: "working", lastActivityAt: 100 }),
      agent({ id: "err", status: "error", lastActivityAt: 50 }),
      agent({ id: "ask", status: "needs_permission", lastActivityAt: 10 }),
    ]);
    expect(projects[0].agents.map((a) => a.id)).toEqual(["ask", "err", "work", "idle"]);
    expect(projects[0].working).toBe(1);
  });

  it("keeps archived agents out of the projects", () => {
    const { projects, archived } = groupByProject([agent({ archived: true }), agent({ projectPath: "/x" })]);
    expect(projects.map((p) => p.name)).toEqual(["x"]);
    expect(archived).toHaveLength(1);
  });

  it("filters agents by title, folder or branch", () => {
    const list = [agent({ title: "Fix login" }), agent({ projectPath: "/work/api", branch: "armada/billing-1" })];
    expect(groupByProject(list, "login").projects).toHaveLength(1);
    expect(groupByProject(list, "billing").projects[0].name).toBe("api");
    expect(groupByProject(list, "nothing").projects).toHaveLength(0);
  });

  it("numbers shortcuts in the sidebar's order", () => {
    const a = agent({ id: "p1", projectPath: "/a", lastActivityAt: 1 });
    const b = agent({ id: "p2", projectPath: "/b", lastActivityAt: 2 });
    const c = agent({ id: "p3", projectPath: "/a", lastActivityAt: 3 });
    // Project /a was active last (3), so it comes first, newest agent first within it.
    expect(orderedAgents([a, b, c]).map((x) => x.id)).toEqual(["p3", "p1", "p2"]);
  });
});
