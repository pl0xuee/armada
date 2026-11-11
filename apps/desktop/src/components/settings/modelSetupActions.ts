// Saving and reverting the model setup, with the toasts that say so (shared by the popup and Settings).
import { toast } from "sonner";
import {
  applySetup,
  describeSetup,
  revertSetup,
  sameClaude,
  type ModelSetup,
  type SaveHelpers,
} from "@/lib/modelSetup";
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

/**
 * Applies a setup and says so, with Undo in the toast. `before` is what the form started from (only
 * changes are saved); `others` names the other providers it changes.
 */
export async function saveModelSetup(setup: ModelSetup, before?: ModelSetup, others: string[] = []): Promise<boolean> {
  const saver = useApp.getState().settings?.tokenSaver;
  let id: number | null;
  try {
    id = await applySetup(setup, saver, saveHelperSettings, before);
  } catch (e) {
    toast.error("Couldn't save the models", {
      description: `${e instanceof Error ? e.message : String(e)}. Revert in Settings puts back what you had.`,
    });
    return false;
  }
  if (id === null) return false;
  const claude = !before || !sameClaude(before, setup);
  toast.success("Models saved", {
    description: [
      claude && `New Claude agents start on ${describeSetup(setup)}.`,
      others.length > 0 && `New ${others.join(", ").replace(/, ([^,]*)$/, " and $1")} agents start on what you chose.`,
      "Running agents keep what they have.",
    ]
      .filter(Boolean)
      .join(" "),
    action: { label: "Undo", onClick: () => void revertModelSetup(id) },
  });
  return true;
}

/** Puts back the models from before the last change (or, given `id`, that change), and says so. */
export async function revertModelSetup(id?: number): Promise<boolean> {
  try {
    if (!(await revertSetup(saveHelperSettings, id))) {
      if (id !== undefined)
        toast.info("Nothing to undo", { description: "That change was already undone or replaced." });
      return false;
    }
  } catch (e) {
    toast.error("Couldn't revert the models", { description: e instanceof Error ? e.message : String(e) });
    return false;
  }
  toast.success("Models reverted", { description: "New agents start on what you had before." });
  return true;
}
