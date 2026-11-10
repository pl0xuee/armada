import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { agentsOffRecommended, readWorkChoice, saveWorkChoice, type SwitchTarget, WORK_TYPES } from "@/lib/modelGuide";
import type { Settings } from "@/lib/types";
import { useApp } from "@/store/app";
import { SettingGroup, SettingRow } from "./SettingRow";
import { saveSettingsPatch } from "./settingsErrors";

/** The kind of work the recommended setup starts new Claude agents on (Opus at medium effort). */
const RECOMMENDED = WORK_TYPES[0];

/** Puts helper agents on Sonnet unless a helper model is already chosen. False if it couldn't save. */
async function helpersOnSonnet(): Promise<boolean> {
  const saver = useApp.getState().settings?.tokenSaver;
  if (!saver || saver.subagentModel) return true;
  return saveSettingsPatch({ tokenSaver: { ...saver, subagentModel: "sonnet" } }, (message) =>
    toast.error("Couldn't save settings", { description: message }),
  );
}

/**
 * Anthropic's advice in one step: new Claude agents start on Opus at medium effort and helper agents
 * run on Sonnet. A helper model you already chose (Sonnet or Haiku) is left alone. Running agents keep
 * what they have. Returns whether it was applied.
 */
export async function applyRecommendedModels(): Promise<boolean> {
  const saver = useApp.getState().settings?.tokenSaver;
  if (!(await helpersOnSonnet())) return false;
  saveWorkChoice(RECOMMENDED.id);
  toast.success("Recommended models are on", {
    description: `New Claude agents start on Opus at ${RECOMMENDED.effort} effort, and their helpers run on ${
      saver?.subagentModel === "haiku" ? "Haiku" : "Sonnet"
    }. Running agents keep what they have; pick another kind of work next to the prompt any time.`,
  });
  return true;
}

const agentsWord = (n: number) => `${n} ${n === 1 ? "agent" : "agents"}`;

/**
 * Moves agents you already have to Opus at medium effort: the model first (a new model can reset
 * effort), then effort. Each keeps its conversation. Helpers go on Sonnet first unless you chose a
 * helper model; an agent picks that up when its Claude Code starts, so an idle one gets it now and a
 * running one on its next restart. Returns how many failed (all of them if the helper setting
 * couldn't be saved).
 */
export async function switchAgentsToRecommended(targets: readonly SwitchTarget[]): Promise<number> {
  const helper = useApp.getState().settings?.tokenSaver.subagentModel === "haiku" ? "Haiku" : "Sonnet";
  if (!(await helpersOnSonnet())) return targets.length;
  const results = await Promise.allSettled(
    targets.map(async ({ agent }) => {
      const opt = (id: string) => agent.configOptions?.find((o) => o.id === id);
      if (opt("model")?.currentValue !== RECOMMENDED.model)
        await api.setAgentConfig(agent.id, "model", RECOMMENDED.model);
      if (opt("effort")?.currentValue !== RECOMMENDED.effort)
        await api.setAgentConfig(agent.id, "effort", RECOMMENDED.effort);
    }),
  );
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed) toast.error(`Couldn't switch ${failed} of ${agentsWord(results.length)}`);
  else
    toast.success(`${agentsWord(results.length)} on Opus at ${RECOMMENDED.effort} effort`, {
      description: `Each keeps its conversation. Helpers run on ${helper}; an agent that was already busy picks that up when Kvistcode restarts.`,
    });
  return failed;
}

/** "Models" group in Settings → Models & spending: one click for the recommended starting point. */
export function ModelGuideSettings({ settings }: { settings: Settings }) {
  const [pick, setPick] = useState(readWorkChoice);
  const inUse = pick === RECOMMENDED.id && !!settings.tokenSaver.subagentModel;
  const agents = useApp((s) => s.agents);
  const targets = useMemo(() => agentsOffRecommended(Object.values(agents)), [agents]);
  const longCount = targets.filter((t) => t.long).length;
  const [asking, setAsking] = useState(false);
  const [switching, setSwitching] = useState(false);
  const run = async (list: readonly SwitchTarget[]) => {
    setAsking(false);
    if (list.length === 0) return;
    setSwitching(true);
    try {
      await switchAgentsToRecommended(list);
    } finally {
      setSwitching(false);
    }
  };
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
      <SettingRow
        title="Agents you have now"
        description="Switch your open Claude agents to Opus at medium effort, with helpers on Sonnet unless you chose another helper model. Each keeps its conversation. On a long conversation, the next message costs more once, because the new model reads it all again. An agent that is busy right now gets the helper change when Kvistcode restarts."
      >
        <Button
          size="sm"
          variant="secondary"
          disabled={targets.length === 0 || switching}
          onClick={() => (longCount ? setAsking(true) : void run(targets))}
        >
          {switching ? "Switching…" : targets.length === 0 ? "All switched" : `Switch ${agentsWord(targets.length)}`}
        </Button>
      </SettingRow>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Switch ${agentsWord(targets.length)} now?`}
        description={`${longCount === 1 ? "One has a long conversation" : `${longCount} have long conversations`}. The new model has to read all of it again, so the next message there costs more than a normal one. You can skip those and switch them later, at a natural break.`}
        confirmLabel="Switch all"
        onConfirm={() => void run(targets)}
      >
        {longCount < targets.length && (
          <Button variant="secondary" onClick={() => void run(targets.filter((t) => !t.long))}>
            Skip long ones
          </Button>
        )}
      </ConfirmDialog>
    </SettingGroup>
  );
}
