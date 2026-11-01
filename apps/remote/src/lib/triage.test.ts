import { describe, expect, it } from "vitest";
import { groupByProject, needsReason, needsYouLabel, projectSummary, reasonLabel, triageQueue, triageSections } from "./triage";
import type { Agent } from "./types";

let n = 0;
const agent = (extra: Partial<Agent> = {}): Agent =>
  ({
    id: `a${++n}`,
    title: `Agent ${n}`,
    status: "idle",
    archived: false,
    unread: false,
    rateLimited: false,
    pendingPermissions: 0,
    acknowledgedAt: null,
    lastActivityAt: 1000,
    projectPath: "/code/web",
    branch: null,
    lastMessage: null,
    ...extra,
  }) as Agent;

describe("needsReason (the desktop's needsAttention)", () => {
  it("is null for quiet, working and archived agents", () => {
    expect(needsReason(agent())).toBeNull();
    expect(needsReason(agent({ status: "working" }))).toBeNull();
    expect(needsReason(agent({ status: "needs_permission", archived: true }))).toBeNull();
  });
  it("puts approvals first, then limits, errors and finished-unread work", () => {
    expect(needsReason(agent({ pendingPermissions: 1 }))).toBe("permission");
    expect(needsReason(agent({ status: "needs_permission" }))).toBe("permission");
    expect(needsReason(agent({ rateLimited: true, status: "error" }))).toBe("rate_limited");
    expect(needsReason(agent({ status: "error" }))).toBe("error");
    expect(needsReason(agent({ unread: true }))).toBe("done");
    expect(needsReason(agent({ unread: true, status: "interrupted" }))).toBe("done");
    expect(needsReason(agent({ unread: true, status: "working" }))).toBeNull();
  });
  it("keeps an approval even after the agent was marked done, but 'Done' dismisses the rest until new activity", () => {
    expect(needsReason(agent({ pendingPermissions: 1, acknowledgedAt: 5000 }))).toBe("permission");
    expect(needsReason(agent({ status: "error", acknowledgedAt: 1000 }))).toBeNull();
    expect(needsReason(agent({ status: "error", acknowledgedAt: 999 }))).toBe("error");
  });
  it("counts an answer on its way as given", () => {
    const a = agent({ pendingPermissions: 1, status: "needs_permission" });
    expect(needsReason(a, 1)).toBe("permission");
    expect(needsReason(a, 0)).toBeNull();
    // No counter, status only: still waiting.
    expect(needsReason(agent({ status: "needs_permission" }), 0)).toBe("permission");
  });
});

describe("triageQueue and sections", () => {
  const list = [
    agent({ id: "done-old", unread: true, lastActivityAt: 10 }),
    agent({ id: "err", status: "error", lastActivityAt: 50 }),
    agent({ id: "perm-new", pendingPermissions: 1, lastActivityAt: 90 }),
    agent({ id: "perm-old", pendingPermissions: 1, lastActivityAt: 20 }),
    agent({ id: "limit", rateLimited: true, status: "error", lastActivityAt: 30 }),
    agent({ id: "quiet" }),
  ];
  it("orders by urgency, then the one waiting longest first", () => {
    expect(triageQueue(list).map((e) => e.agent.id)).toEqual(["perm-old", "perm-new", "limit", "err", "done-old"]);
  });
  it("splits Blocked from To review and omits empty sections", () => {
    const secs = triageSections(triageQueue(list));
    expect(secs.map((s) => [s.id, s.entries.length])).toEqual([
      ["blocked", 4],
      ["review", 1],
    ]);
    expect(triageSections(triageQueue([agent()]))).toEqual([]);
    expect(triageSections(triageQueue([agent({ unread: true })])).map((s) => s.label)).toEqual(["To review"]);
  });
  it("uses the injected pending counts, so the badge and the queue cannot disagree", () => {
    const a = agent({ pendingPermissions: 1, status: "needs_permission" });
    expect(triageQueue([a], () => 0)).toEqual([]);
    expect(triageQueue([a], () => 1)).toHaveLength(1);
  });
});

describe("labels", () => {
  it("reads like the desktop", () => {
    expect(reasonLabel("permission")).toBe("Needs approval");
    expect(reasonLabel("permission", true)).toBe("Needs you");
    expect(reasonLabel("done")).toBe("Done · unread");
    expect(needsYouLabel(1)).toBe("1 agent needs you");
    expect(needsYouLabel(3)).toBe("3 agents need you");
  });
});

describe("groupByProject", () => {
  const agents = [
    agent({ id: "w1", projectPath: "/code/web/", status: "working", lastActivityAt: 500 }),
    agent({ id: "w2", projectPath: "/code/web", lastActivityAt: 100 }),
    agent({ id: "w3", projectPath: "/code/web", pendingPermissions: 1, lastActivityAt: 50 }),
    agent({ id: "api1", projectPath: "/code/api", lastActivityAt: 900 }),
    agent({ id: "docs1", projectPath: "/code/docs", status: "error", lastActivityAt: 10 }),
    agent({ id: "old", projectPath: "/code/web", archived: true, lastActivityAt: 5 }),
  ];
  it("groups by folder (a trailing slash is the same folder) and counts what needs you", () => {
    const { projects, archived } = groupByProject(agents);
    expect(projects.map((p) => [p.name, p.agents.length, p.needs, p.working])).toEqual([
      ["web", 3, 1, 1],
      ["docs", 1, 1, 0],
      ["api", 1, 0, 0],
    ]);
    expect(archived.map((a) => a.id)).toEqual(["old"]);
  });
  it("orders a project's agents: needs you, then working, then the most recent", () => {
    expect(groupByProject(agents).projects[0].agents.map((a) => a.id)).toEqual(["w3", "w1", "w2"]);
  });
  it("puts projects that need you first, then the most recently active", () => {
    const calm = groupByProject(agents.filter((a) => a.id !== "w3" && a.id !== "docs1")).projects.map((p) => p.name);
    expect(calm).toEqual(["api", "web"]);
  });
  it("filters like the desktop sidebar and shares the badge's rule through reasonOf", () => {
    expect(groupByProject(agents, "docs1").projects).toEqual([]);
    expect(groupByProject(agents, "/code/docs").projects.map((p) => p.name)).toEqual(["docs"]);
    const none = groupByProject(agents, "", () => null).projects;
    expect(none.every((p) => p.needs === 0)).toBe(true);
  });
  it("summarises a project", () => {
    expect(projectSummary({ agents: [agent(), agent()], working: 1 })).toBe("2 agents · 1 working");
    expect(projectSummary({ agents: [agent()], working: 0 })).toBe("1 agent");
  });
  it("does not crash on agents whose folder the server hides", () => {
    const { projects } = groupByProject([agent({ projectPath: undefined })]);
    expect(projects[0].name).toBe("Other");
  });
});
