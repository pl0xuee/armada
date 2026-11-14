import { sidebarGroupOf, type Look, type SidebarGroup } from "@/lib/look";
import { useUi } from "@/store/ui";

export function useLook(): Look {
  return useUi((s) => s.look);
}

/** True in the Minimal look. */
export function useMinimal(): boolean {
  return useUi((s) => s.look === "minimal");
}

/**
 * The sidebar lists agents by activity (Minimal, "Activity"): ⌘1–9 and the like follow that order.
 * `sections`: how many sections the user made (with none chosen, people with sections see projects).
 */
export const byActivity = (s: { look: Look; sidebarGroup: SidebarGroup | null }, sections: number): boolean =>
  s.look === "minimal" && sidebarGroupOf(s.sidebarGroup, sections) === "activity";
