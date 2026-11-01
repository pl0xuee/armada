import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui";
import { holdReach, holdText, holdTitle, raiseLabel, raiseSteps, type HoldChoice, type HoldLike } from "@/lib/budgetHold";
import { confirmAction } from "@/lib/confirm";
import { plural } from "@/lib/format";
import { resolveBudgetHold } from "@/lib/phoneActions";
import { useStore } from "@/lib/store";
import type { Agent } from "@/lib/types";

/**
 * An agent held at a limit: what happened, and the ways to go on (raise the limit, continue for one turn, stop).
 * Written from the hold's own fields, so a kind of limit this app has no wording for still reads sensibly. The
 * agent screen's dock shows one raise step; the Needs-you card has room for two.
 */
export function HoldBody({ agent, hold, compact, onContinued }: { agent: Agent; hold: HoldLike; compact?: boolean; onContinued?: () => void }) {
  const busy = useStore((s) => !!s.busy[`budget:${agent.id}`]);
  const queued = agent.queuedPrompts ?? 0;
  const [first, second] = raiseSteps(hold);
  const reach = holdReach(hold, agent.projectPath);

  const choose = async (choice: HoldChoice) => {
    if (choice.action === "stop" && queued > 0) {
      const ok = await confirmAction({
        title: "Stop this agent?",
        body: `${plural(queued, "queued message")} will be dropped.`,
        confirmLabel: "Stop",
        destructive: true,
      });
      if (!ok) return;
    }
    const taken = await resolveBudgetHold(agent.id, choice);
    // Nothing queued to run: the next step is yours, so go to the conversation.
    if (taken && choice.action === "continue_once" && queued === 0) onContinued?.();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-warn/40 bg-warn/15 text-warn">
          <Icon name="gauge" size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14.5px] leading-snug font-semibold text-fg">{holdTitle(hold)}</p>
          <p className="mt-0.5 text-[13px] leading-snug break-words text-muted">
            {holdText(hold)} It finished its turn first, so nothing was cut off.
            {queued > 0 && ` ${plural(queued, "queued message")} ${queued === 1 ? "is" : "are"} waiting.`}
          </p>
          {reach && <p className="mt-1 text-[12.5px] leading-snug text-steel">{reach}</p>}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button size="md" variant="warn" icon="arrowUp" disabled={busy} className={compact ? "col-span-2" : undefined} onClick={() => void choose({ action: "raise", by: first })}>
          Raise by {raiseLabel(hold, first)}
        </Button>
        {!compact && (
          <Button size="md" variant="secondary" disabled={busy} onClick={() => void choose({ action: "raise", by: second })}>
            Raise by {raiseLabel(hold, second)}
          </Button>
        )}
        <Button size="md" variant="secondary" icon="play" disabled={busy} onClick={() => void choose({ action: "continue_once" })}>
          Continue once
        </Button>
        <Button size="md" variant="ghost" icon="stop" disabled={busy} onClick={() => void choose({ action: "stop" })}>
          Stop
        </Button>
      </div>
    </div>
  );
}
