import type { Look, SidebarGroup } from "@/lib/look";
import { useUi } from "@/store/ui";

export function useLook(): Look {
  return useUi((s) => s.look);
}

/** True in the Minimal look. */
export function useMinimal(): boolean {
  return useUi((s) => s.look === "minimal");
}

/** The sidebar lists agents by activity (Minimal, "By activity"): ⌘1–9 and the like follow that order. */
export const byActivity = (s: { look: Look; sidebarGroup: SidebarGroup }): boolean =>
  s.look === "minimal" && s.sidebarGroup === "activity";
