/**
 * The desktop sidebar's sections and project order, on the phone. The phone's copy of `arrange` in
 * `apps/desktop/src/lib/projectLayout.ts`: the same sections, names and order, read-only here (the
 * layout is changed on the computer and arrives with `/api/state` and the `project_layout` event).
 */
import { projectKey } from "./triage";
import type { ProjectLayout, ProjectSection } from "./types";

export const EMPTY_LAYOUT: ProjectLayout = { customOrder: false, order: [], sections: [] };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * The layout a server sent, or no sections when it sent none (an older desktop, a share link) or
 * something unreadable. A section needs an id and a name; anything else about it is optional.
 */
export function parseLayout(raw: unknown): ProjectLayout {
  if (!raw || typeof raw !== "object") return EMPTY_LAYOUT;
  const x = raw as { customOrder?: unknown; order?: unknown; sections?: unknown };
  const seen = new Set<string>();
  const sections: ProjectSection[] = [];
  for (const s of Array.isArray(x.sections) ? x.sections : []) {
    if (!s || typeof s !== "object") continue;
    const { id, name, projects } = s as { id?: unknown; name?: unknown; projects?: unknown };
    if (typeof id !== "string" || !id || seen.has(id) || typeof name !== "string" || !name.trim()) continue;
    seen.add(id);
    sections.push({ id, name, projects: strings(projects) });
  }
  const order = strings(x.order);
  if (!sections.length && !order.length && x.customOrder !== true) return EMPTY_LAYOUT;
  return { customOrder: x.customOrder === true, order, sections };
}

/** Whether two layouts list the same thing (so an unchanged one doesn't re-render the list). */
export function sameLayout(a: ProjectLayout, b: ProjectLayout): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export interface Arranged<P> {
  /** Projects in no section: listed first, without a header. */
  loose: P[];
  sections: { section: ProjectSection; projects: P[] }[];
}

/**
 * Splits `projects` (in the automatic order: needing you, then recent activity) into the user's sections.
 * With the custom order every group follows the user's list, and projects not listed yet (a new folder)
 * lead their group in the automatic order so they're seen; otherwise each group keeps the automatic order.
 */
export function arrange<P extends { path: string }>(projects: readonly P[], layout: ProjectLayout): Arranged<P> {
  // A project listed in two sections belongs to the first.
  const home = new Map<string, string>();
  for (const s of layout.sections) for (const p of s.projects) if (!home.has(projectKey(p))) home.set(projectKey(p), s.id);
  const sorted = (list: P[], order: readonly string[]) => {
    if (!layout.customOrder) return list;
    const rank = new Map<string, number>();
    order.forEach((p, i) => rank.has(projectKey(p)) || rank.set(projectKey(p), i));
    return list
      .map((p, i) => ({ p, i, r: rank.get(projectKey(p.path)) ?? -1 }))
      .sort((x, y) => x.r - y.r || x.i - y.i)
      .map((x) => x.p);
  };
  const bySection = new Map<string, P[]>(layout.sections.map((s) => [s.id, []]));
  const loose: P[] = [];
  for (const p of projects) {
    const id = home.get(projectKey(p.path));
    const list = id === undefined ? undefined : bySection.get(id);
    if (list) list.push(p);
    else loose.push(p);
  }
  return {
    loose: sorted(loose, layout.order),
    sections: layout.sections.map((section) => ({ section, projects: sorted(bySection.get(section.id) ?? [], section.projects) })),
  };
}

/** The key a section's fold state is remembered under, next to the projects' folder paths (as on the desktop). */
export const sectionFoldKey = (id: string) => `section:${id}`;

/** "2 projects · 5 agents · 1 working" under a section's name. */
export function sectionSummary(projects: readonly { agents: readonly unknown[]; working: number }[]): string {
  if (!projects.length) return "No agents here";
  const agents = projects.reduce((n, p) => n + p.agents.length, 0);
  const working = projects.reduce((n, p) => n + p.working, 0);
  return [
    `${projects.length} ${projects.length === 1 ? "project" : "projects"}`,
    `${agents} ${agents === 1 ? "agent" : "agents"}`,
    working > 0 ? `${working} working` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
