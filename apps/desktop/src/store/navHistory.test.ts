import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedAgents } from "@/lib/mock-data";
import type { Agent } from "@/lib/types";
import { useApp } from "./app";
import { goBack, goForward, installNavHistory, NAV_LIMIT, placeLabel, useNav } from "./navHistory";
import { useUi } from "./ui";

const base = seedAgents()[0];
const agent = (id: string, title = id): Agent => ({ ...base, id, title, archived: false });
const settle = () => new Promise<void>((r) => queueMicrotask(r));
const where = () => {
  const s = useUi.getState();
  return s.view === "agents" ? `agents:${s.selectedAgentId ?? "-"}` : s.view;
};

let off: () => void = () => {};

beforeEach(() => {
  useApp.setState({ agents: { a: agent("a", "Fix the login"), b: agent("b"), c: agent("c") } });
  useUi.setState({
    view: "agents",
    selectedAgentId: null,
    tileGroup: null,
    missionTab: null,
    settingsSection: "appearance",
    compareGroupId: null,
  });
  off = installNavHistory();
});

afterEach(() => off());

describe("Back and Forward", () => {
  it("steps back and forward through views and agents", async () => {
    const ui = useUi.getState();
    ui.openAgent("a");
    await settle();
    ui.setView("schedules");
    await settle();
    ui.openSettings("voice");
    await settle();

    expect(goBack()).toBe(true);
    expect(where()).toBe("schedules");
    expect(goBack()).toBe(true);
    expect(where()).toBe("agents:a");
    expect(goBack()).toBe(true);
    expect(where()).toBe("agents:-");
    expect(goBack()).toBe(false);

    expect(goForward()).toBe(true);
    expect(goForward()).toBe(true);
    expect(where()).toBe("schedules");
    expect(goForward()).toBe(true);
    expect(useUi.getState().settingsSection).toBe("voice");
    expect(goForward()).toBe(false);
  });

  it("counts several updates from one click as one step", async () => {
    useUi.getState().setView("usage");
    useUi.getState().openAgent("b");
    await settle();
    expect(useNav.getState().back).toHaveLength(1);
    goBack();
    expect(where()).toBe("agents:-");
  });

  it("going somewhere new drops the forward steps", async () => {
    useUi.getState().setView("usage");
    await settle();
    goBack();
    expect(useNav.getState().forward).toHaveLength(1);
    useUi.getState().setView("accounts");
    await settle();
    expect(useNav.getState().forward).toHaveLength(0);
  });

  it("Mission Control picking its own tab is not a step", async () => {
    useUi.getState().setView("mission");
    await settle();
    useUi.getState().openMission("needs"); // what the view does when it opens
    await settle();
    expect(useNav.getState().back).toHaveLength(1);
    useUi.getState().openMission("all");
    await settle();
    goBack();
    expect(useUi.getState().missionTab).toBe("needs");
  });

  it("skips agents that were deleted since", async () => {
    const ui = useUi.getState();
    ui.openAgent("a");
    await settle();
    ui.openAgent("b");
    await settle();
    ui.setView("usage");
    await settle();
    const { b: _gone, ...rest } = useApp.getState().agents;
    useApp.setState({ agents: rest });
    goBack();
    expect(where()).toBe("agents:a");
  });

  it("keeps the tiled agents that still exist", async () => {
    useUi.getState().openAgents(["a", "b", "c"], "a");
    await settle();
    useUi.getState().setView("usage");
    await settle();
    const { c: _gone, ...rest } = useApp.getState().agents;
    useApp.setState({ agents: rest });
    goBack();
    expect(useUi.getState().tileGroup).toEqual(["a", "b"]);
  });

  it("stays bounded", async () => {
    for (let i = 0; i < NAV_LIMIT + 10; i++) {
      useUi.getState().setView(i % 2 ? "usage" : "accounts");
      await settle();
    }
    expect(useNav.getState().back).toHaveLength(NAV_LIMIT);
  });

  it("names places for the tooltips", () => {
    expect(placeLabel({ ...blankPlace(), view: "agents", agentId: "a" })).toBe("Fix the login");
    expect(placeLabel({ ...blankPlace(), view: "agents", agentId: null })).toBe("Projects");
    expect(placeLabel({ ...blankPlace(), view: "mission", missionTab: "all" })).toBe("Mission Control: All agents");
  });
});

function blankPlace() {
  return {
    view: "agents" as const,
    agentId: null,
    tileGroup: null,
    missionTab: null,
    settingsSection: "appearance" as const,
    compareGroupId: null,
  };
}
