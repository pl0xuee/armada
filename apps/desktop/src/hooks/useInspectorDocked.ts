import { INSPECTOR_DOCK_QUERY } from "@/lib/layout";
import { useMediaQuery } from "./useMediaQuery";
import { useMinimal } from "./useLook";
import { useUi } from "@/store/ui";

/**
 * Whether the details panel takes its own column beside the conversation. Classic docks it on wide
 * windows; Minimal never does: there it is a card over the conversation, opened on demand.
 */
export function useInspectorDocked(): boolean {
  const wide = useMediaQuery(INSPECTOR_DOCK_QUERY);
  const minimal = useMinimal();
  return wide && !minimal;
}

/** Show or hide the details panel the way the header's button does (outside React: the palette). */
export function toggleInspector() {
  const ui = useUi.getState();
  const docked = window.matchMedia(INSPECTOR_DOCK_QUERY).matches && ui.look !== "minimal";
  if (docked) ui.setInspectorOpen(!ui.inspectorOpen);
  else ui.setInspectorOverlay(!ui.inspectorOverlay);
}
