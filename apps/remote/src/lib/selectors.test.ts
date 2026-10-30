import { describe, expect, it } from "vitest";
import { groupFleet, isUsageLimited, needsYou, pendingCount, pendingKindOf, permissionIndex, waitingLabel } from "./selectors";
import type { Agent, PendingItem, PermissionItem, TimelineItem } from "./types";

const perm = (requestId: string, resolution: string | null): TimelineItem => ({
  id: requestId,
  agentId: "a",
  seq: 1,
  ts: 0,
  kind: "permission",
  requestId,
  title: requestId,
  toolKind: null,
  command: null,
  diffs: [],
  options: [],
  resolution,
});
const agent = (pendingPermissions: number) => ({ id: "a", pendingPermissions }) as Agent;

describe("pendingCount", () => {
  const perms = (...ids: string[]) => ids.map((id) => perm(id, null) as PermissionItem);
  it("still shows the other requests after answering one of several (no double counting)", () => {
    // Two pending; the server then reported 1 left after we answered r1 (removed from the list).
    expect(pendingCount(agent(1), perms("r2"), true, {})).toBe(1);
    expect(pendingCount(agent(2), perms("r2"), true, {})).toBe(1);
  });
  it("excludes answers in flight", () => {
    expect(pendingCount(agent(2), perms("r1", "r2"), true, { r1: "allow" })).toBe(1);
  });
  it("trusts the agent count until the approvals list is loaded", () => {
    expect(pendingCount(agent(3), undefined, false, {})).toBe(3);
  });
  it("never shows stale items for an agent with nothing pending", () => {
    expect(pendingCount(agent(0), perms("r1"), true, {})).toBe(0);
  });
});

describe("permissionIndex", () => {
  it("groups unresolved approvals per agent, oldest first", () => {
    const a = { ...perm("a", null), ts: 2 } as PermissionItem;
    const b = { ...perm("b", null), ts: 1 } as PermissionItem;
    const c = { ...perm("c", "allow"), ts: 0 } as PermissionItem;
    const index = permissionIndex({ a, b, c });
    expect(index.get("a")?.map((p) => p.requestId)).toEqual(["b", "a"]);
  });
});

describe("questions in the pending list", () => {
  const ask = (requestId: string): TimelineItem => ({ id: requestId, agentId: "a", seq: 1, ts: 0, kind: "question", requestId, message: "?", fields: [], resolution: null });
  it("are grouped and counted with approvals", () => {
    const a = ask("q1") as PendingItem;
    const p = perm("r1", null) as PendingItem;
    expect(permissionIndex({ q1: a, r1: p }).get("a")).toHaveLength(2);
    expect(pendingCount(agent(2), [a, p], true, {})).toBe(2);
    expect(pendingCount(agent(2), [a, p], true, { q1: "answered" })).toBe(1);
  });
  it("names what is waiting", () => {
    expect(waitingLabel(1, 0)).toBe("1 approval waiting");
    expect(waitingLabel(3, 0)).toBe("3 approvals waiting");
    expect(waitingLabel(1, 1)).toBe("1 question waiting");
    expect(waitingLabel(3, 1)).toBe("3 requests waiting");
  });
});

describe("groupFleet", () => {
  const ag = (id: string, over: Partial<Agent> = {}): Agent =>
    ({ id, title: id, status: "idle", archived: false, pendingPermissions: 0, rateLimited: false, lastActivityAt: 0, ...over }) as Agent;
  const ids = (list: Agent[], group: string) => groupFleet(list).find((g) => g.id === group)!.agents.map((a) => a.id);

  it("puts approvals, errors and interrupted agents under Needs you, most urgent first", () => {
    const list = [
      ag("int", { status: "interrupted", lastActivityAt: 9 }),
      ag("err", { status: "error", lastActivityAt: 5 }),
      ag("ask", { status: "needs_permission", lastActivityAt: 1 }),
      ag("idle-with-pending", { pendingPermissions: 1, lastActivityAt: 3 }),
    ];
    // Approvals first (newest activity first among them), then errors, then interrupted.
    expect(ids(list, "needs")).toEqual(["idle-with-pending", "ask", "err", "int"]);
  });
  it("counts a rate-limited agent as needing you whatever its status", () => {
    const list = [ag("limited-idle", { rateLimited: true }), ag("limited-err", { status: "error", rateLimited: true }), ag("fine")];
    expect(ids(list, "needs").sort()).toEqual(["limited-err", "limited-idle"]);
    expect(ids(list, "recent")).toEqual(["fine"]);
    expect(needsYou(ag("x", { rateLimited: true }))).toBe(true);
    expect(needsYou(ag("x"))).toBe(false);
  });
  it("sorts the rest and keeps archived agents out of Needs you", () => {
    const list = [
      ag("w-old", { status: "working", lastActivityAt: 1 }),
      ag("w-new", { status: "starting", lastActivityAt: 2 }),
      ag("done", { status: "stopped", lastActivityAt: 3 }),
      ag("old", { status: "error", archived: true }),
    ];
    expect(ids(list, "working")).toEqual(["w-new", "w-old"]);
    expect(ids(list, "recent")).toEqual(["done"]);
    expect(ids(list, "archived")).toEqual(["old"]);
    expect(ids(list, "needs")).toEqual([]);
  });
});

describe("isUsageLimited", () => {
  it("is a rate-limited agent that isn't busy with something else", () => {
    expect(isUsageLimited({ rateLimited: true, status: "error" })).toBe(true);
    expect(isUsageLimited({ rateLimited: true, status: "idle" })).toBe(true);
    expect(isUsageLimited({ rateLimited: true, status: "working" })).toBe(false);
    expect(isUsageLimited({ rateLimited: true, status: "needs_permission" })).toBe(false);
    expect(isUsageLimited({ rateLimited: false, status: "error" })).toBe(false);
  });
});

describe("pendingKindOf", () => {
  const q = { kind: "question" } as PendingItem;
  const p = { kind: "permission" } as PendingItem;
  it("is a question only when nothing but questions wait", () => {
    expect(pendingKindOf(undefined)).toBeNull();
    expect(pendingKindOf([])).toBeNull();
    expect(pendingKindOf([q])).toBe("question");
    expect(pendingKindOf([q, p])).toBe("permission");
    expect(pendingKindOf([p])).toBe("permission");
  });
});
