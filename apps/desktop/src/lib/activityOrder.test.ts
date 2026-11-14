import { describe, expect, it } from "vitest";
import { groupByActivity, orderedAgents, sidebarOrder } from "./agents";
import type { Agent } from "./types";
import { sidebarGroupOf } from "./look";

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

const ids = (list: Agent[]) => list.map((a) => a.id);

describe("groupByActivity (the Minimal sidebar)", () => {
  it("lists what needs you, then what is working; the rest is settled, latest first", () => {
    const idleOld = agent({ id: "idle-old", lastActivityAt: 10 });
    const idleNew = agent({ id: "idle-new", lastActivityAt: 90 });
    const working = agent({ id: "working", status: "working", lastActivityAt: 500 });
    const approval = agent({ id: "approval", status: "needs_permission", lastActivityAt: 1 });
    const failed = agent({ id: "failed", status: "error", lastActivityAt: 400 });
    const review = agent({ id: "review", unread: true, lastActivityAt: 300 });
    const g = groupByActivity([idleOld, working, review, idleNew, failed, approval]);
    expect(ids(g.active)).toEqual(["approval", "failed", "review", "working"]);
    expect(ids(g.settled)).toEqual(["idle-new", "idle-old"]);
  });

  it("leaves archived agents out, whatever their state (they are listed apart)", () => {
    const g = groupByActivity([
      agent({ id: "gone", archived: true, status: "error" }),
      agent({ id: "here", status: "working" }),
    ]);
    expect(ids(g.active)).toEqual(["here"]);
    expect(g.settled).toEqual([]);
  });

  it("counts an idle agent with background work as working", () => {
    const a = agent({ id: "bg" });
    expect(ids(groupByActivity([a]).settled)).toEqual(["bg"]);
    expect(ids(groupByActivity([a], "", new Set(["bg"])).active)).toEqual(["bg"]);
  });

  it("lists a main agent as active while one of its helpers works", () => {
    const main = agent({ id: "main" });
    const helper = agent({ id: "helper", parentId: "main", status: "working" });
    const g = groupByActivity([main], "", undefined, new Map([["main", [helper]]]));
    expect(ids(g.active)).toEqual(["main"]);
    expect(g.settled).toEqual([]);
  });

  it("filters by title, folder, branch and last message", () => {
    const list = [
      agent({ id: "t", title: "Fix the Login page" }),
      agent({ id: "p", projectPath: "/work/login-api" }),
      agent({ id: "b", branch: "kv/login" }),
      agent({ id: "m", lastMessage: "the login test passes" }),
      agent({ id: "x", title: "Other" }),
    ];
    expect(ids(groupByActivity(list, " LOGIN ").settled).sort()).toEqual(["b", "m", "p", "t"]);
  });

  it("orders ties the same way every time", () => {
    const list = [agent({ id: "b" }), agent({ id: "a" }), agent({ id: "c" })];
    expect(ids(groupByActivity(list).settled)).toEqual(["a", "b", "c"]);
    expect(ids(groupByActivity([...list].reverse()).settled)).toEqual(["a", "b", "c"]);
  });
});

describe("sidebarOrder (⌘1–9 and Alt+↑/↓)", () => {
  it("follows the rows top to bottom when listed by activity, helpers after their main agent", () => {
    const main = agent({ id: "main", lastActivityAt: 50 });
    const helper = agent({ id: "helper", parentId: "main", status: "working", lastActivityAt: 60, createdAt: 2 });
    const idle = agent({ id: "idle", projectPath: "/work/a-first", lastActivityAt: 90 });
    const approval = agent({ id: "approval", projectPath: "/work/z-last", status: "needs_permission" });
    const all = [idle, main, helper, approval];
    expect(ids(sidebarOrder(all, undefined, true))).toEqual(["approval", "main", "helper", "idle"]);
    // Listed by project, it is the project order as before.
    expect(sidebarOrder(all, undefined, false)).toEqual(orderedAgents(all));
  });

  it("leaves archived agents out", () => {
    const kept = agent({ id: "kept" });
    const gone = agent({ id: "gone", archived: true, status: "needs_permission" });
    expect(ids(sidebarOrder([kept, gone], undefined, true))).toEqual(["kept"]);
  });
});

describe("sidebarGroupOf (Minimal sidebar: Activity or Projects)", () => {
  it("keeps a saved choice", () => {
    expect(sidebarGroupOf("activity", 3)).toBe("activity");
    expect(sidebarGroupOf("project", 0)).toBe("project");
  });

  it("without one, shows projects to people who made sections, activity to everyone else", () => {
    expect(sidebarGroupOf(null, 2)).toBe("project");
    expect(sidebarGroupOf(null, 0)).toBe("activity");
  });
});
