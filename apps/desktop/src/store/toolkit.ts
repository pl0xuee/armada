import { create } from "zustand";
import type { ToolkitTab } from "@/lib/toolkit";
import { useProjectSettings } from "./projectSettings";
import { useUi } from "./ui";

interface ToolkitState {
  tab: ToolkitTab;
  setTab: (tab: ToolkitTab) => void;
}

export const useToolkit = create<ToolkitState>((set) => ({
  tab: "instructions",
  setTab: (tab) => set({ tab }),
}));

/** Opens Settings → Projects, optionally on a tab and for a project. */
export function openToolkit(tab?: ToolkitTab, project?: string | null) {
  if (tab) useToolkit.getState().setTab(tab);
  if (project) useProjectSettings.getState().setProject(project);
  useUi.getState().openSettings("toolkit");
}
