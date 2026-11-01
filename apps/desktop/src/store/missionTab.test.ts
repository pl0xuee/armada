import { beforeEach, describe, expect, it } from "vitest";
import { useUi, viewFromUrl } from "./ui";

beforeEach(() => useUi.setState({ view: "agents", missionTab: null }));

describe("Mission Control tabs", () => {
  it("maps the old triage and inbox links to the Needs you tab", () => {
    expect(viewFromUrl("triage")).toEqual({ view: "mission", tab: "needs" });
    expect(viewFromUrl("inbox")).toEqual({ view: "mission", tab: "needs" });
    expect(viewFromUrl("mission")).toEqual({ view: "mission", tab: null });
    expect(viewFromUrl("nope")).toBeNull();
    expect(viewFromUrl(null)).toBeNull();
  });

  it("opens a given tab", () => {
    useUi.getState().openMission("all");
    expect(useUi.getState()).toMatchObject({ view: "mission", missionTab: "all" });
  });

  it("re-picks the tab when you arrive from another view, but keeps it when you are already there", () => {
    useUi.getState().openMission("all");
    useUi.getState().setView("usage");
    useUi.getState().setView("mission");
    expect(useUi.getState().missionTab).toBeNull();
    useUi.getState().openMission("all");
    useUi.getState().setView("mission");
    expect(useUi.getState().missionTab).toBe("all");
  });

  it("ignores a view name it doesn't know", () => {
    useUi.getState().setView("nope" as never);
    expect(useUi.getState().view).toBe("agents");
  });
});
