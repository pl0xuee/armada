import { describe, expect, it } from "vitest";
import { pendingCount, permissionIndex } from "./selectors";
import type { Agent, PermissionItem, TimelineItem } from "./types";

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
