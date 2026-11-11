// Saving and reverting the model setup, with the toasts that say so (shared by the popup and Settings).
import { toast } from "sonner";
import { applySetup, describeSetup, revertSetup, type ModelSetup, type SaveHelpers } from "@/lib/modelSetup";
import { useApp } from "@/store/app";
import { saveSettingsPatch } from "./settingsErrors";

/** Saves the helper model and effort settings (for the model setup and its revert). */
export const saveHelperSettings: SaveHelpers = (patch) => {
  const saver = useApp.getState().settings?.tokenSaver;
  if (!saver) return Promise.resolve(false);
  return saveSettingsPatch({ tokenSaver: { ...saver, ...patch } }, (message) =>
    toast.error("Couldn't save settings", { description: message }),
  );
};

/** Applies a setup and says so, with Undo in the toast. */
export async function saveModelSetup(setup: ModelSetup): Promise<boolean> {
  const saver = useApp.getState().settings?.tokenSaver;
  try {
    if (!(await applySetup(setup, saver, saveHelperSettings))) return false;
  } catch (e) {
    toast.error("Couldn't save the models", { description: e instanceof Error ? e.message : String(e) });
    return false;
  }
  toast.success("Models saved", {
    description: `New Claude agents start on ${describeSetup(setup)}. Running agents keep what they have.`,
    action: { label: "Undo", onClick: () => void revertModelSetup() },
  });
  return true;
}

/** Puts back the models from before the last change, and says so. */
export async function revertModelSetup(): Promise<boolean> {
  try {
    if (!(await revertSetup(saveHelperSettings))) return false;
  } catch (e) {
    toast.error("Couldn't revert the models", { description: e instanceof Error ? e.message : String(e) });
    return false;
  }
  toast.success("Models reverted", { description: "New Claude agents start on what you had before." });
  return true;
}
