import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { readWorkChoice, saveWorkChoice, WORK_TYPES } from "@/lib/modelGuide";
import type { Settings } from "@/lib/types";
import { useApp } from "@/store/app";
import { SettingGroup, SettingRow } from "./SettingRow";
import { saveSettingsPatch } from "./settingsErrors";

/** The kind of work the recommended setup starts new Claude agents on (Opus at medium effort). */
const RECOMMENDED = WORK_TYPES[0];

/**
 * Anthropic's advice in one step: new Claude agents start on Opus at medium effort and helper agents
 * run on Sonnet. A helper model you already chose (Sonnet or Haiku) is left alone. Running agents keep
 * what they have. Returns whether it was applied.
 */
export async function applyRecommendedModels(): Promise<boolean> {
  const saver = useApp.getState().settings?.tokenSaver;
  if (saver && !saver.subagentModel) {
    const saved = await saveSettingsPatch({ tokenSaver: { ...saver, subagentModel: "sonnet" } }, (message) =>
      toast.error("Couldn't save settings", { description: message }),
    );
    if (!saved) return false;
  }
  saveWorkChoice(RECOMMENDED.id);
  toast.success("Recommended models are on", {
    description: `New Claude agents start on Opus at ${RECOMMENDED.effort} effort, and their helpers run on ${
      saver?.subagentModel === "haiku" ? "Haiku" : "Sonnet"
    }. Running agents keep what they have; pick another kind of work next to the prompt any time.`,
  });
  return true;
}

/** "Models" group in Settings → Behavior: one click for the recommended starting point. */
export function ModelGuideSettings({ settings }: { settings: Settings }) {
  const [pick, setPick] = useState(readWorkChoice);
  const inUse = pick === RECOMMENDED.id && !!settings.tokenSaver.subagentModel;
  return (
    <SettingGroup title="Models">
      <SettingRow
        title="Recommended setup"
        description="From Anthropic's model guide: new Claude agents start on Opus at medium effort, and helper agents run on Sonnet. Choose another kind of work, like routine tasks or a big refactor, next to the prompt when you start an agent. Running agents are not changed."
      >
        <Button
          size="sm"
          variant="secondary"
          disabled={inUse}
          onClick={() => void applyRecommendedModels().then((ok) => ok && setPick(RECOMMENDED.id))}
        >
          {inUse ? "In use" : "Use recommended"}
        </Button>
      </SettingRow>
    </SettingGroup>
  );
}
