import { describe, expect, it } from "vitest";
import { arrange, EMPTY_LAYOUT, parseLayout, sameLayout, sectionFoldKey, sectionSummary, type Arranged } from "./projectLayout";
import type { ProjectLayout, ProjectSection } from "./types";

const P = (...paths: string[]) => paths.map((path) => ({ path }));
const paths = (a: Arranged<{ path: string }>) => ({
  loose: a.loose.map((p) => p.path),
  sections: a.sections.map((s) => [s.section.name, s.projects.map((p) => p.path)] as const),
});
const layout = (over: Partial<ProjectLayout> = {}): ProjectLayout => ({ customOrder: false, order: [], sections: [], ...over });
const sec = (id: string, name: string, projects: string[] = []): ProjectSection => ({ id, name, projects });

describe("arrange", () => {
  it("lists every project loose, in the order given, without a layout", () => {
    expect(paths(arrange(P("/a", "/b", "/c"), EMPTY_LAYOUT))).toEqual({ loose: ["/a", "/b", "/c"], sections: [] });
  });

  it("puts projects in their sections, in the sections' own order, and leaves the rest loose", () => {
    const l = layout({ sections: [sec("w", "Work", ["/api", "/web"]), sec("s", "Side", ["/blog"])] });
    expect(paths(arrange(P("/web", "/notes", "/blog", "/api"), l))).toEqual({
      loose: ["/notes"],
      sections: [
        ["Work", ["/web", "/api"]],
        ["Side", ["/blog"]],
      ],
    });
  });

  it("keeps the automatic order inside a section until the custom order is on", () => {
    const sections = [sec("w", "Work", ["/api", "/web"])];
    const projects = P("/web", "/api");
    expect(paths(arrange(projects, layout({ sections }))).sections).toEqual([["Work", ["/web", "/api"]]]);
    expect(paths(arrange(projects, layout({ sections, customOrder: true }))).sections).toEqual([["Work", ["/api", "/web"]]]);
  });

  it("follows the saved order for loose projects, with a project not listed yet first", () => {
    const l = layout({ customOrder: true, order: ["/c", "/a", "/b"] });
    expect(paths(arrange(P("/a", "/new", "/b", "/c"), l)).loose).toEqual(["/new", "/c", "/a", "/b"]);
  });

  it("keeps a section that has no projects here, so the list matches the computer's", () => {
    const l = layout({ sections: [sec("w", "Work", ["/gone"]), sec("e", "Empty")] });
    expect(paths(arrange(P("/a"), l))).toEqual({
      loose: ["/a"],
      sections: [
        ["Work", []],
        ["Empty", []],
      ],
    });
  });

  it("gives a project listed in two sections to the first", () => {
    const l = layout({ sections: [sec("a", "One", ["/x"]), sec("b", "Two", ["/x", "/y"])] });
    expect(paths(arrange(P("/x", "/y"), l)).sections).toEqual([
      ["One", ["/x"]],
      ["Two", ["/y"]],
    ]);
  });

  it("matches a folder whether or not either side has a trailing slash", () => {
    const l = layout({ customOrder: true, order: ["/b/", "/a"], sections: [sec("w", "Work", ["/web/"])] });
    expect(paths(arrange(P("/a", "/web", "/b"), l))).toEqual({ loose: ["/b", "/a"], sections: [["Work", ["/web"]]] });
    expect(paths(arrange(P("/web/"), layout({ sections: [sec("w", "Work", ["/web"])] }))).sections).toEqual([["Work", ["/web/"]]]);
  });

  it("carries whatever else a project holds through untouched", () => {
    const projects = [
      { path: "/a", name: "a", agents: [1, 2] },
      { path: "/b", name: "b", agents: [] },
    ];
    const a = arrange(projects, layout({ sections: [sec("w", "Work", ["/b"])] }));
    expect(a.loose[0]).toBe(projects[0]);
    expect(a.sections[0].projects[0]).toBe(projects[1]);
  });
});

describe("parseLayout", () => {
  it("is no sections for an older computer, a share link, or anything unreadable", () => {
    for (const raw of [undefined, null, "sections", 3, [], {}, { sections: "no" }, { sections: [], order: [], customOrder: false }]) {
      expect(parseLayout(raw)).toEqual(EMPTY_LAYOUT);
    }
  });

  it("reads what the computer saved", () => {
    const raw = { customOrder: true, order: ["/a", "/b"], sections: [{ id: "w", name: "Work", projects: ["/a"] }] };
    expect(parseLayout(raw)).toEqual(raw);
  });

  it("drops what it cannot use and keeps the rest", () => {
    const raw = {
      customOrder: "yes",
      order: ["/a", 4, null, "/b"],
      sections: [
        { id: "w", name: "Work", projects: ["/a", 7] },
        { id: "", name: "No id" },
        { id: "n", name: "   " },
        { id: "w", name: "Same id again" },
        null,
        "text",
        { id: "s", name: "Side" },
      ],
    };
    expect(parseLayout(raw)).toEqual({
      customOrder: false,
      order: ["/a", "/b"],
      sections: [
        { id: "w", name: "Work", projects: ["/a"] },
        { id: "s", name: "Side", projects: [] },
      ],
    });
  });
});

describe("sameLayout", () => {
  it("tells a changed layout from the same one sent again", () => {
    const a = layout({ sections: [sec("w", "Work", ["/a"])] });
    expect(sameLayout(a, a)).toBe(true);
    expect(sameLayout(a, layout({ sections: [sec("w", "Work", ["/a"])] }))).toBe(true);
    expect(sameLayout(a, layout({ sections: [sec("w", "Work!", ["/a"])] }))).toBe(false);
    expect(sameLayout(a, layout({ sections: [sec("w", "Work", ["/a"])], customOrder: true }))).toBe(false);
  });
});

describe("sections on the list", () => {
  it("remembers a section's fold apart from any folder path", () => {
    expect(sectionFoldKey("abc")).toBe("section:abc");
    expect(sectionFoldKey("abc").startsWith("/")).toBe(false);
  });

  it("sums a section up in a line", () => {
    const g = (agents: number, working: number) => ({ agents: Array.from({ length: agents }), working });
    expect(sectionSummary([])).toBe("No agents here");
    expect(sectionSummary([g(1, 0)])).toBe("1 project · 1 agent");
    expect(sectionSummary([g(3, 1), g(2, 0)])).toBe("2 projects · 5 agents · 1 working");
  });
});
