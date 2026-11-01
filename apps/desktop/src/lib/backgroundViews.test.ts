import { describe, expect, it } from "vitest";
import { matchesFilter } from "@/components/mission/useFleet";
import { reasonLabel } from "@/components/triage/useTriage";
import { groupByProject } from "./agents";
import { seedAgents } from "./mock-data";
import type { Agent } from "./types";
import { windowTitle } from "./windowTitle";

const a = (over: Partial<Agent>): Agent => ({ ...seedAgents()[0], id: "x", title: "Fix login", ...over });

describe("background work in the views", () => {
  it("the window title names what still runs instead of Done", () => {
    expect(windowTitle(a({ status: "idle" }), true, "Workflow 3 of 5 running")).toBe(
      "● Workflow 3 of 5 running — Fix login · Kvistcode",
    );
    expect(windowTitle(a({ status: "idle" }), true, null)).toBe("✓ Done — Fix login · Kvistcode");
    // Only an idle agent is reinterpreted.
    expect(windowTitle(a({ status: "working" }), false, "Workflow running")).toBe("● Working — Fix login · Kvistcode");
  });

  it("Mission Control counts an idle agent with background work as live, not idle", () => {
    const idle = a({ status: "idle" });
    const bg = new Set(["x"]);
    expect(matchesFilter(idle, "live")).toBe(false);
    expect(matchesFilter(idle, "idle")).toBe(true);
    expect(matchesFilter(idle, "live", bg)).toBe(true);
    expect(matchesFilter(idle, "idle", bg)).toBe(false);
    expect(matchesFilter(a({ status: "stopped" }), "live", bg)).toBe(false);
    expect(matchesFilter(idle, "all", bg)).toBe(true);
  });

  it("the sidebar counts it as working", () => {
    const list = [a({ id: "x", status: "idle", projectPath: "/p" }), a({ id: "y", status: "idle", projectPath: "/p" })];
    expect(groupByProject(list).projects[0].working).toBe(0);
    expect(groupByProject(list, "", new Set(["x"])).projects[0].working).toBe(1);
  });

  it("an unread agent whose work goes on is 'Turn finished', not 'Done'", () => {
    expect(reasonLabel("done")).toBe("Done · unread");
    expect(reasonLabel("done", false, true)).toBe("Turn finished · unread");
    expect(reasonLabel("permission", false, true)).toBe("Needs approval");
  });
});
