// Kvistcode has two layouts ("looks") over the same features and themes:
//   classic: the icon rail, project tree, header bar and side inspector.
//   minimal: one sidebar by activity, a single raised sheet, a floating details card.
// The choice lives in localStorage (it is a view preference of this window, like the open panels) and is
// mirrored on <html data-look> so CSS can style by it (the `minimal:` Tailwind variant in globals.css).
// Keep LOOK_KEY in step with public/theme-init.js, which paints it before the app loads.
// Components read it with useLook / useMinimal (hooks/useLook.ts).

export type Look = "classic" | "minimal";

export const LOOK_KEY = "kvistcode.look";
export const DEFAULT_LOOK: Look = "classic";

export const LOOKS: { id: Look; name: string; description: string }[] = [
  { id: "classic", name: "Classic", description: "Everything in view: icon rail, project tree and side panels." },
  { id: "minimal", name: "Minimal", description: "One sidebar and the conversation. Details open when you ask." },
];

export function isLook(v: unknown): v is Look {
  return v === "classic" || v === "minimal";
}

export function readLook(): Look {
  try {
    const v = localStorage.getItem(LOOK_KEY);
    return isLook(v) ? v : DEFAULT_LOOK;
  } catch {
    return DEFAULT_LOOK;
  }
}

export function saveLook(look: Look) {
  try {
    localStorage.setItem(LOOK_KEY, look);
  } catch {
    /* ignore */
  }
}

/** Put the look on <html> (what CSS reads). */
export function applyLook(look: Look) {
  if (typeof document !== "undefined") document.documentElement.dataset.look = look;
}

/** How the Minimal sidebar lists agents: by what is happening, or under their projects (as Classic does). */
export type SidebarGroup = "activity" | "project";
const SIDEBAR_GROUP_KEY = "kvistcode.sidebarGroup";

/** The saved choice; null until one is made (see sidebarGroupOf). */
export function readSidebarGroup(): SidebarGroup | null {
  try {
    const v = localStorage.getItem(SIDEBAR_GROUP_KEY);
    return v === "project" || v === "activity" ? v : null;
  } catch {
    return null;
  }
}

/** The grouping in effect: the saved choice, else by project for people who made sections, else by activity. */
export function sidebarGroupOf(saved: SidebarGroup | null, sections: number): SidebarGroup {
  return saved ?? (sections > 0 ? "project" : "activity");
}

export function saveSidebarGroup(group: SidebarGroup) {
  try {
    localStorage.setItem(SIDEBAR_GROUP_KEY, group);
  } catch {
    /* ignore */
  }
}
