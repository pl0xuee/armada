import { CirclePause, Play, Square, TrendingUp } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { attempt } from "@/lib/actions";
import { api } from "@/lib/api";
import { costIsEquivalent, holdText, raiseLabel, raiseSteps } from "@/lib/budgetMeters";
import type { Agent, BudgetChoice } from "@/lib/types";
import { basename } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";

/** An agent held at a spending limit: what happened, and the three ways to go on. */
export function BudgetHoldPanel({ agent }: { agent: Agent }) {
  const hold = agent.budgetHold;
  const equivalent = useApp((s) => costIsEquivalent(agent, s.accounts));
  const [busy, setBusy] = useState(false);
  if (!hold) return null;
  const steps = raiseSteps(hold);

  const choose = async (choice: BudgetChoice, failure: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const settings = await attempt(failure, () => api.budgetResolve(agent.id, choice));
      // A raised project or daily limit lives in the settings.
      if (settings) useApp.setState({ settings });
      if (settings && choice.action === "continue_once" && agent.queuedPrompts === 0) {
        // Nothing queued to run: the next step is yours.
        useUi.getState().openAgent(agent.id);
        useUi.getState().focusComposer();
      }
    } finally {
      setBusy(false);
    }
  };

  const where =
    hold.scope === "project"
      ? `Raising it changes the limit for every agent in ${basename(agent.projectPath)}.`
      : hold.scope === "daily"
        ? "Raising it changes today's limit for all agents."
        : null;

  return (
    <div className="rounded-xl border border-warn/35 bg-warn/[0.06] p-4">
      <div className="flex items-start gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-warn/40 bg-warn/15 text-warn">
          <CirclePause className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold">Paused at a spending limit</p>
          <p className="selectable mt-0.5 break-words text-[12.5px] leading-relaxed text-muted">
            {holdText(hold, equivalent)} It finished its turn first, so nothing was cut off.
            {agent.queuedPrompts > 0 &&
              ` ${agent.queuedPrompts} queued ${agent.queuedPrompts === 1 ? "message is" : "messages are"} waiting.`}
          </p>
          {hold.metric === "cost" && equivalent && (
            <p className="mt-1 text-[12px] leading-relaxed text-steel">
              Subscriptions aren&rsquo;t billed per token, so a turn or token limit may fit this account better.
            </p>
          )}
          {where && <p className="mt-1 text-[12px] leading-relaxed text-steel">{where}</p>}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 pl-[38px]">
        <Button
          size="sm"
          variant="warn"
          disabled={busy}
          onClick={() =>
            void choose({ action: "raise", by: steps[0]! }, "Couldn't raise the limit")
          }
        >
          <TrendingUp className="!h-3.5 !w-3.5" /> Raise limit by {raiseLabel(hold, steps[0]!)}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void choose({ action: "raise", by: steps[1]! }, "Couldn't raise the limit")}
        >
          Raise by {raiseLabel(hold, steps[1]!)}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          title="Let it run one more turn. The limit is checked again when that turn ends."
          onClick={() => void choose({ action: "continue_once" }, "Couldn't continue")}
        >
          <Play className="!h-3.5 !w-3.5" /> Continue once
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          title="Don't continue: drop the queued messages and dismiss this."
          onClick={() => void choose({ action: "stop" }, "Couldn't stop")}
        >
          <Square className="!h-3 !w-3" /> Stop
        </Button>
      </div>
    </div>
  );
}
