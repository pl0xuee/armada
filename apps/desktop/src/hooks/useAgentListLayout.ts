import { LIST_DOCK_QUERY } from "@/lib/layout";
import { useUi } from "@/store/ui";
import { useMediaQuery } from "./useMediaQuery";

/** Docked list on wide windows, off-canvas drawer on narrow ones; each remembers its own state. */
export function useAgentListLayout() {
  const docked = useMediaQuery(LIST_DOCK_QUERY);
  const layout = docked ? "wide" : "narrow";
  const open = useUi((s) => s.agentList[layout]);
  const toggle = () => useUi.getState().setAgentList(layout, !useUi.getState().agentList[layout]);
  const close = () => useUi.getState().setAgentList(layout, false);
  return { docked, open, toggle, close };
}

/** Imperative toggle for keyboard shortcuts (reads the current breakpoint directly). */
export function toggleAgentList() {
  const layout = window.matchMedia(LIST_DOCK_QUERY).matches ? "wide" : "narrow";
  const ui = useUi.getState();
  ui.setAgentList(layout, !ui.agentList[layout]);
}
