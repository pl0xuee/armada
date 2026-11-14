import { sidebarOrder } from "@/lib/agents";
import { layoutOf } from "@/lib/projectLayout";
import { byActivity } from "@/hooks/useLook";
import { useApp } from "./app";
import { useBackgroundStore } from "./background";
import { useUi } from "./ui";

/** The agents in the sidebar's order, as ⌘1–9, Alt+↑/↓ and the voice assistant number them. */
export function shortcutOrder() {
  const app = useApp.getState();
  const layout = layoutOf(app.settings);
  return sidebarOrder(
    Object.values(app.agents),
    layout,
    byActivity(useUi.getState(), layout.sections.length),
    useBackgroundStore.getState().active,
  );
}
