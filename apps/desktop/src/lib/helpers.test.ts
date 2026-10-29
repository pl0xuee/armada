import { describe, expect, it } from "vitest";
import {
  canStartHelper,
  decideBusySend,
  helperGroupOf,
  nestHelpers,
  planTiles,
  resizeTiles,
  syncPresentation,
  tileCapacity,
} from "./helpers";
import type { Agent } from "./types";

const ag = (id: string, over: Partial<Agent> = {}): Agent =>
  ({
    id,
    title: id,
    status: "working",
    running: true,
    archived: false,
    parentId: null,
    helperSync: null,
    createdAt: 1,
    ...over,
  }) as Agent;

describe("decideBusySend", () => {
  it("follows the setting for plain sends", () => {
    expect(decideBusySend("ask", "enter")).toBe("ask");
    expect(decideBusySend("queue", "queueButton")).toBe("queue");
    expect(decideBusySend("helper", "enter")).toBe("helper");
  });
  it("explicit helper gestures always start a helper", () => {
    expect(decideBusySend("queue", "modEnter")).toBe("helper");
    expect(decideBusySend("queue", "helperMenu")).toBe("helper");
  });
  it("queues when helpers aren't allowed", () => {
    expect(decideBusySend("helper", "enter", false)).toBe("queue");
    expect(decideBusySend("ask", "modEnter", false)).toBe("queue");
  });
  it("helpers and stopped agents cannot start helpers", () => {
    expect(canStartHelper(ag("a"))).toBe(true);
    expect(canStartHelper(ag("h", { parentId: "a" }))).toBe(false);
    expect(canStartHelper(ag("s", { status: "stopped", running: false }))).toBe(false);
  });
});

describe("tiling", () => {
  it("capacity from width", () => {
    expect(tileCapacity(1600)).toBe(4);
    expect(tileCapacity(1100)).toBe(3);
    expect(tileCapacity(200)).toBe(1);
  });
  it("shows everything that fits", () => {
    expect(planTiles(["m", "a", "b"], "m", 3)).toEqual({ visible: ["m", "a", "b"], hidden: [] });
  });
  it("overflows the tail and keeps the focused tile visible", () => {
    expect(planTiles(["m", "a", "b", "c"], "m", 2)).toEqual({ visible: ["m", "a"], hidden: ["b", "c"] });
    expect(planTiles(["m", "a", "b", "c"], "c", 2)).toEqual({ visible: ["m", "c"], hidden: ["a", "b"] });
    expect(planTiles(["m", "a", "b"], "b", 1)).toEqual({ visible: ["b"], hidden: ["m", "a"] });
  });
  it("resizes a divider within the minimum", () => {
    expect(resizeTiles([500, 500], 0, 100, 360)).toEqual([600, 400]);
    expect(resizeTiles([500, 500], 0, 400, 360)).toEqual([640, 360]);
    expect(resizeTiles([500, 500], 0, -400, 360)).toEqual([360, 640]);
    // Neighbours already below the minimum can't move.
    expect(resizeTiles([400, 300, 300], 1, 50, 360)).toEqual([400, 300, 300]);
  });
});

describe("grouping", () => {
  const agents = [
    ag("m", { createdAt: 1 }),
    ag("h2", { parentId: "m", createdAt: 3 }),
    ag("h1", { parentId: "m", createdAt: 2 }),
    ag("hx", { parentId: "m", createdAt: 4, archived: true }),
    ag("solo"),
  ];
  it("group of main or helper", () => {
    expect(helperGroupOf(agents, "m")?.helpers.map((h) => h.id)).toEqual(["h1", "h2"]);
    expect(helperGroupOf(agents, "h2")?.main.id).toBe("m");
    expect(helperGroupOf(agents, "solo")).toBeNull();
    expect(helperGroupOf(agents, "hx")).toBeNull();
  });
  it("nests helpers under their main agent", () => {
    const { roots, children } = nestHelpers(agents);
    expect(roots.map((a) => a.id)).toEqual(["m", "hx", "solo"]);
    expect(children.get("m")?.map((a) => a.id)).toEqual(["h1", "h2"]);
  });
  it("surfaces a helper that needs attention as its own row", () => {
    const { roots, children } = nestHelpers([
      ag("m"),
      ag("h1", { parentId: "m", status: "needs_permission" }),
      ag("h2", { parentId: "m", pendingPermissions: 1 } as never),
      ag("h3", { parentId: "m" }),
    ]);
    expect(roots.map((a) => a.id)).toEqual(["m", "h1", "h2"]);
    expect(children.get("m")?.map((a) => a.id)).toEqual(["h3"]);
  });
  it("keeps orphans as roots", () => {
    expect(nestHelpers([ag("h", { parentId: "gone" })]).roots.map((a) => a.id)).toEqual(["h"]);
  });
});

describe("syncPresentation", () => {
  const s = (state: string, files = 0) => ({ state, files, lastSyncAt: null, detail: null }) as never;
  it("labels each state", () => {
    expect(syncPresentation(s("inSync", 3), "Claude").label).toBe("In sync · 3 files");
    expect(syncPresentation(s("inSync", 1), "Claude").label).toBe("In sync · 1 file");
    expect(syncPresentation(s("pendingToMain"), "Claude").label).toBe("Waiting for Claude to finish");
    expect(syncPresentation(s("conflict"), "Claude").tone).toBe("warn");
  });
});
