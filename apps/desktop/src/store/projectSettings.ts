import { create } from "zustand";
import type { InstructionFileName } from "@/lib/projectConfig";
import { useUi } from "./ui";

/** Key of one instruction file's unsaved text. */
export const draftKey = (project: string, file: InstructionFileName) => `${project}\u0000${file}`;

interface ProjectSettingsState {
  /** Project the Settings → Projects screen shows (null = the first one available). */
  project: string | null;
  /** Unsaved instruction-file text. Kept here so edits survive switching project, tab or screen. */
  drafts: Record<string, string>;
  setProject: (project: string | null) => void;
  setDraft: (key: string, text: string) => void;
  clearDraft: (key: string) => void;
}

export const useProjectSettings = create<ProjectSettingsState>((set) => ({
  project: null,
  drafts: {},
  setProject: (project) => set({ project }),
  setDraft: (key, text) => set((s) => ({ drafts: { ...s.drafts, [key]: text } })),
  clearDraft: (key) =>
    set((s) => {
      if (!(key in s.drafts)) return s;
      const drafts = { ...s.drafts };
      delete drafts[key];
      return { drafts };
    }),
}));

/** Opens Settings → Projects on `project`. */
export function openProjectSettings(project: string) {
  useProjectSettings.getState().setProject(project);
  useUi.getState().openSettings("projects");
}
