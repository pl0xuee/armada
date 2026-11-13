import { sidebarOrder } from "@/lib/agents";
import { layoutOf } from "@/lib/projectLayout";
import { byActivity } from "@/hooks/useLook";
import { useApp } from "./app";
import { useBackgroundStore } from "./background";
import { useUi } from "./ui";

/** The agents in the sidebar's order, as ⌘1–9, Alt+↑/↓ and the voice assistant number them. */
export function shortcutOrder() {
  const app = useApp.getState();
  return sidebarOrder(
    Object.values(app.agents),
    layoutOf(app.settings),
    byActivity(useUi.getState()),
    useBackgroundStore.getState().active,
  );
}
