import { describe, expect, it } from "vitest";
import { orderedAgents } from "./agents";
import {
  addSection,
  arrange,
  EMPTY_LAYOUT,
  layoutProblem,
  moveProject,
  moveSection,
  nudgeProject,
  placeProject,
  removeSection,
  renameSection,
  withCustomOrder,
} from "./projectLayout";
import type { Agent, ProjectLayout } from "./types";

const P = (...paths: string[]) => paths.map((path) => ({ path }));
const paths = (a: ReturnType<typeof arrange<{ path: string }>>) => ({
  loose: a.loose.map((p) => p.path),
  sections: a.sections.map((g) => [g.section.name, g.projects.map((p) => p.path)]),
});
const layout = (over: Partial<ProjectLayout> = {}): ProjectLayout => ({ ...EMPTY_LAYOUT, ...over });
const sec = (id: string, name: string, projects: string[] = []) => ({ id, name, projects });

describe("arrange", () => {
  it("keeps the automatic order without a layout", () => {
    expect(paths(arrange(P("/a", "/b"), EMPTY_LAYOUT))).toEqual({ loose: ["/a", "/b"], sections: [] });
  });

  it("puts sectioned projects in their section, in the automatic order unless the order is custom", () => {
    const l = layout({ sections: [sec("w", "Websites", ["/c", "/a"])] });
    expect(paths(arrange(P("/a", "/b", "/c"), l))).toEqual({ loose: ["/b"], sections: [["Websites", ["/a", "/c"]]] });
    expect(paths(arrange(P("/a", "/b", "/c"), { ...l, customOrder: true }))).toEqual({
      loose: ["/b"],
      sections: [["Websites", ["/c", "/a"]]],
    });
  });

  it("lists a project the custom order doesn't know yet first, and keeps empty sections", () => {
    const l = layout({ customOrder: true, order: ["/b", "/a"], sections: [sec("g", "Games")] });
    expect(paths(arrange(P("/a", "/new", "/b"), l))).toEqual({
      loose: ["/new", "/b", "/a"],
      sections: [["Games", []]],
    });
  });

  it("matches stored paths with a trailing slash", () => {
    const l = layout({ sections: [sec("w", "Websites", ["/a/"])] });
    expect(paths(arrange(P("/a"), l)).sections).toEqual([["Websites", ["/a"]]]);
  });
});

describe("moving projects", () => {
  const l = layout({ sections: [sec("w", "Websites", ["/c"]), sec("g", "Games")] });
  const shown = arrange(P("/a", "/b", "/c"), l);

  it("moves to a spot and switches to the custom order, keeping the rest as shown", () => {
    const next = moveProject(l, shown, "/b", { section: null, index: 0 });
    expect(next.customOrder).toBe(true);
    expect(paths(arrange(P("/a", "/b", "/c"), next))).toEqual({
      loose: ["/b", "/a"],
      sections: [
        ["Websites", ["/c"]],
        ["Games", []],
      ],
    });
  });

  it("moves into and out of sections", () => {
    const into = moveProject(l, shown, "/a", { section: "g", index: 0 });
    expect(paths(arrange(P("/a", "/b", "/c"), into)).sections).toEqual([
      ["Websites", ["/c"]],
      ["Games", ["/a"]],
    ]);
    const out = moveProject(into, arrange(P("/a", "/b", "/c"), into), "/c", { section: null, index: 1 });
    expect(paths(arrange(P("/a", "/b", "/c"), out)).loose).toEqual(["/b", "/c"]);
  });

  it("lists a project once even when a hand-edited layout has it twice", () => {
    const l2 = layout({ order: ["/a/"], sections: [sec("g", "Games", ["/a"])] });
    const next = withCustomOrder(l2, arrange(P("/a", "/b"), l2));
    expect(next.order).toEqual(["/b"]);
    expect(next.sections[0].projects).toEqual(["/a"]);
    expect(layoutProblem(next)).toBeNull();
  });

  it("keeps the place of folders that have no agents right now", () => {
    const l2 = layout({ customOrder: true, order: ["/gone", "/a", "/b"] });
    const next = moveProject(l2, arrange(P("/a", "/b"), l2), "/b", { section: null, index: 0 });
    expect(next.order).toEqual(["/b", "/a", "/gone"]);
  });

  it("places a project last in a section without changing the order mode", () => {
    const next = placeProject(l, shown, "/a", "w");
    expect(next.customOrder).toBe(false);
    expect(next.sections[0].projects).toEqual(["/c", "/a"]);
    expect(next.order).not.toContain("/a");
  });

  it("nudges within a group and across into the next one", () => {
    const custom = withCustomOrder(l, shown);
    const view = arrange(P("/a", "/b", "/c"), custom);
    expect(nudgeProject(custom, view, "/a", 1)?.spot).toEqual({ section: null, index: 1 });
    expect(nudgeProject(custom, view, "/b", 1)?.spot).toEqual({ section: "w", index: 0 });
    expect(nudgeProject(custom, view, "/c", -1)?.spot).toEqual({ section: null, index: 2 });
    expect(nudgeProject(custom, view, "/a", -1)).toBeNull();
  });
});

describe("sections", () => {
  it("adds, renames, moves and removes sections", () => {
    const { layout: one, id } = addSection(EMPTY_LAYOUT, "  Websites  ");
    expect(one.sections).toEqual([{ id, name: "Websites", projects: [] }]);
    expect(renameSection(one, id, "   ").sections[0].name).toBe("Websites");
    expect(renameSection(one, id, "Sites").sections[0].name).toBe("Sites");
    const { layout: two, id: id2 } = addSection(one, "");
    expect(two.sections[1].name).toBe("New section");
    expect(moveSection(two, id2, 0).sections.map((s) => s.id)).toEqual([id2, id]);
  });

  it("a new section can take a project with it", () => {
    const l = layout({ order: ["/a"] });
    const { layout: next, id } = addSection(l, "Games", arrange(P("/a", "/b"), l), "/a");
    expect(next.sections.find((s) => s.id === id)?.projects).toEqual(["/a"]);
    expect(next.order).not.toContain("/a");
  });

  it("removing a section returns its projects to no section", () => {
    const l = layout({ order: ["/a"], sections: [sec("g", "Games", ["/b", "/a"])] });
    expect(removeSection(l, "g")).toEqual({ customOrder: false, order: ["/a", "/b"], sections: [] });
  });

  it("names are trimmed and capped at 60 characters", () => {
    const { layout: l } = addSection(EMPTY_LAYOUT, "x".repeat(80));
    expect(l.sections[0].name).toHaveLength(60);
  });
});

describe("layoutProblem", () => {
  it("accepts a good layout and refuses what the backend refuses", () => {
    expect(layoutProblem(layout({ order: ["/a"], sections: [sec("g", "Games", ["/b"])] }))).toBeNull();
    expect(layoutProblem(layout({ sections: [sec("g", " ")] }))).toBe("A section needs a name.");
    expect(layoutProblem(layout({ sections: [sec("g", "x".repeat(61))] }))).toMatch(/up to 60/);
    expect(layoutProblem(layout({ sections: [sec("g", "A"), sec("g", "B")] }))).toMatch(/same id/);
    expect(layoutProblem(layout({ order: ["/a"], sections: [sec("g", "A", ["/a"])] }))).toMatch(/more than once/);
  });
});

describe("orderedAgents with a layout", () => {
  const agent = (id: string, projectPath: string, lastActivityAt: number) =>
    ({
      id,
      projectPath,
      lastActivityAt,
      title: id,
      status: "idle",
      archived: false,
      configOptions: [],
    }) as unknown as Agent;

  it("numbers agents in the sidebar's order: no section first, then the sections", () => {
    const agents = [agent("x", "/a", 3), agent("y", "/b", 2), agent("z", "/c", 1)];
    const l = layout({ sections: [sec("g", "Games", ["/a"])] });
    expect(orderedAgents(agents).map((a) => a.id)).toEqual(["x", "y", "z"]);
    expect(orderedAgents(agents, l).map((a) => a.id)).toEqual(["y", "z", "x"]);
  });
});
