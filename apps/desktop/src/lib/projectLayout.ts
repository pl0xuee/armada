import { projectKey } from "./projectKey";
import type { ProjectLayout, ProjectSection } from "./types";
import { uuid } from "./utils";

export const EMPTY_LAYOUT: ProjectLayout = { customOrder: false, order: [], sections: [] };
export const SECTION_NAME_MAX = 60;
export const MAX_SECTIONS = 100;

/** The sidebar layout in settings (settings saved by older versions have none). */
export const layoutOf = (s: { projectLayout?: ProjectLayout } | null | undefined): ProjectLayout =>
  s?.projectLayout ?? EMPTY_LAYOUT;

export interface Arranged<P> {
  /** Projects in no section: listed first, without a header. */
  loose: P[];
  sections: { section: ProjectSection; projects: P[] }[];
}

/** Where a project goes: a section (null = none) and its place among that group's other projects. */
export interface Spot {
  section: string | null;
  index: number;
}

/**
 * Splits `projects` (in the automatic order: needing you, then recent activity) into the user's sections. With the
 * custom order every group follows the user's list, and projects not listed yet (a new folder) lead their group in the
 * automatic order so they're seen; otherwise each group keeps the automatic order.
 */
export function arrange<P extends { path: string }>(projects: P[], layout: ProjectLayout): Arranged<P> {
  const home = new Map<string, string>();
  for (const s of layout.sections)
    for (const p of s.projects) if (!home.has(projectKey(p))) home.set(projectKey(p), s.id);
  const sorted = (list: P[], order: string[]) => {
    if (!layout.customOrder) return list;
    const rank = new Map<string, number>();
    order.forEach((p, i) => rank.has(projectKey(p)) || rank.set(projectKey(p), i));
    return list
      .map((p, i) => ({ p, i, r: rank.get(p.path) ?? -1 }))
      .sort((x, y) => x.r - y.r || x.i - y.i)
      .map((x) => x.p);
  };
  const bySection = new Map<string, P[]>(layout.sections.map((s) => [s.id, []]));
  const loose: P[] = [];
  for (const p of projects) {
    const id = home.get(p.path);
    if (id) bySection.get(id)!.push(p);
    else loose.push(p);
  }
  return {
    loose: sorted(loose, layout.order),
    sections: layout.sections.map((section) => ({
      section,
      projects: sorted(bySection.get(section.id) ?? [], section.projects),
    })),
  };
}

/** The paths of an arrangement, group by group. */
function shown(arranged: Arranged<{ path: string }>) {
  return {
    loose: arranged.loose.map((p) => p.path),
    sections: new Map(arranged.sections.map((g) => [g.section.id, g.projects.map((p) => p.path)])),
  };
}

/** What's on screen, then what the stored list has that isn't (a folder with no agents now keeps its place). */
const merged = (onScreen: string[], stored: string[]) => {
  const seen = new Set(onScreen);
  return [...onScreen, ...stored.map(projectKey).filter((p) => !seen.has(p) && (seen.add(p), true))];
};

/** The custom order, starting from what's on screen. Each project ends up listed once. */
export function withCustomOrder(layout: ProjectLayout, arranged: Arranged<{ path: string }>): ProjectLayout {
  const s = shown(arranged);
  const placed = new Set<string>();
  const once = (list: string[]) => list.filter((p) => !placed.has(p) && (placed.add(p), true));
  const sections = layout.sections.map((sec) => ({
    ...sec,
    projects: once(merged(s.sections.get(sec.id) ?? [], sec.projects)),
  }));
  return { customOrder: true, order: once(merged(s.loose, layout.order)), sections };
}

/** Puts `path` at `spot` and switches to the custom order, everything else staying where it is on screen. */
export function moveProject(
  layout: ProjectLayout,
  arranged: Arranged<{ path: string }>,
  path: string,
  spot: Spot,
): ProjectLayout {
  const base = withCustomOrder(layout, arranged);
  const without = (list: string[]) => list.filter((p) => p !== path);
  const insert = (list: string[]) => {
    const out = without(list);
    out.splice(Math.max(0, Math.min(spot.index, out.length)), 0, path);
    return out;
  };
  const known = spot.section !== null && base.sections.some((s) => s.id === spot.section);
  const target = known ? spot.section : null;
  return {
    customOrder: true,
    order: target === null ? insert(base.order) : without(base.order),
    sections: base.sections.map((s) => ({
      ...s,
      projects: s.id === target ? insert(s.projects) : without(s.projects),
    })),
  };
}

/** Where `path` is now: its group and its place in it. */
export function spotOf(arranged: Arranged<{ path: string }>, path: string): Spot | null {
  const i = arranged.loose.findIndex((p) => p.path === path);
  if (i >= 0) return { section: null, index: i };
  for (const g of arranged.sections) {
    const j = g.projects.findIndex((p) => p.path === path);
    if (j >= 0) return { section: g.section.id, index: j };
  }
  return null;
}

/** Puts `path` last in a section (null = no section), keeping the current order mode. */
export function placeProject(
  layout: ProjectLayout,
  arranged: Arranged<{ path: string }>,
  path: string,
  section: string | null,
): ProjectLayout {
  const group =
    section === null ? arranged.loose : (arranged.sections.find((g) => g.section.id === section)?.projects ?? []);
  const index = group.filter((p) => p.path !== path).length;
  return { ...moveProject(layout, arranged, path, { section, index }), customOrder: layout.customOrder };
}

/**
 * One place up (-1) or down (+1). Past the top or bottom of its group the project moves into the group before or after
 * (no section, then the sections in order). Null when it can't move further.
 */
export function nudgeProject(
  layout: ProjectLayout,
  arranged: Arranged<{ path: string }>,
  path: string,
  delta: -1 | 1,
): { layout: ProjectLayout; spot: Spot } | null {
  const at = spotOf(arranged, path);
  if (!at) return null;
  const groups: { id: string | null; size: number }[] = [
    { id: null, size: arranged.loose.length },
    ...arranged.sections.map((g) => ({ id: g.section.id, size: g.projects.length })),
  ];
  const gi = groups.findIndex((g) => g.id === at.section);
  const next = at.index + delta;
  let spot: Spot;
  if (next >= 0 && next < groups[gi].size) spot = { section: at.section, index: next };
  else if (delta < 0 && gi > 0) spot = { section: groups[gi - 1].id, index: groups[gi - 1].size };
  else if (delta > 0 && gi < groups.length - 1) spot = { section: groups[gi + 1].id, index: 0 };
  else return null;
  return { layout: moveProject(layout, arranged, path, spot), spot };
}

/** A section name as saved: trimmed and at most `SECTION_NAME_MAX` characters (empty when there is nothing). */
export const cleanSectionName = (name: string) => [...name.trim()].slice(0, SECTION_NAME_MAX).join("").trim();

/** Adds a section at the end, optionally holding `path` (taken out of wherever it was). */
export function addSection(
  layout: ProjectLayout,
  name: string,
  arranged?: Arranged<{ path: string }>,
  path?: string,
): { layout: ProjectLayout; id: string } {
  const id = uuid();
  const next = {
    ...layout,
    sections: [...layout.sections, { id, name: cleanSectionName(name) || "New section", projects: [] }],
  };
  if (!arranged || !path) return { layout: next, id };
  const withNew: Arranged<{ path: string }> = {
    ...arranged,
    sections: [...arranged.sections, { section: next.sections[next.sections.length - 1], projects: [] }],
  };
  return { layout: placeProject(next, withNew, path, id), id };
}

export function renameSection(layout: ProjectLayout, id: string, name: string): ProjectLayout {
  const clean = cleanSectionName(name);
  if (!clean) return layout;
  return { ...layout, sections: layout.sections.map((s) => (s.id === id ? { ...s, name: clean } : s)) };
}

/** Removes a section; its projects go back to no section, after the projects already there. */
export function removeSection(layout: ProjectLayout, id: string): ProjectLayout {
  const gone = layout.sections.find((s) => s.id === id);
  if (!gone) return layout;
  const order = merged(layout.order.map(projectKey), gone.projects);
  return { ...layout, order, sections: layout.sections.filter((s) => s.id !== id) };
}

/** Moves a section to `index` among the other sections. */
export function moveSection(layout: ProjectLayout, id: string, index: number): ProjectLayout {
  const s = layout.sections.find((x) => x.id === id);
  if (!s) return layout;
  const rest = layout.sections.filter((x) => x.id !== id);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, s);
  return { ...layout, sections: rest };
}

/** Why the backend would refuse this layout, in the same words; null when it is fine. */
export function layoutProblem(layout: ProjectLayout): string | null {
  if (layout.sections.length > MAX_SECTIONS) return `You can have up to ${MAX_SECTIONS} sections.`;
  const ids = new Set<string>();
  for (const s of layout.sections) {
    if (!s.id.trim() || [...s.id].length > 64) return "A section needs an id of up to 64 characters.";
    if (ids.has(s.id)) return "Two sections have the same id.";
    ids.add(s.id);
    if (!s.name.trim()) return "A section needs a name.";
    if ([...s.name].length > SECTION_NAME_MAX) return `Section names can be up to ${SECTION_NAME_MAX} characters.`;
  }
  const all = [...layout.order, ...layout.sections.flatMap((s) => s.projects)];
  if (all.length > 2000) return "The sidebar can list up to 2000 projects in its order and sections.";
  const seen = new Set<string>();
  for (const p of all) {
    if (!p.trim()) return "A project in the sidebar order has no folder.";
    if ([...p].length > 4096) return "A project folder in the sidebar order is longer than 4096 characters.";
    if (seen.has(p)) return `The sidebar lists ${p} more than once.`;
    seen.add(p);
  }
  return null;
}
