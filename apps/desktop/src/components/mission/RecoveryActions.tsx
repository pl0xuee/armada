import { Play, Repeat, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CONTINUE_PROMPT, attempt, resumeAgent } from "@/lib/actions";
import { api } from "@/lib/api";
import type { Agent } from "@/lib/types";
import { useUi } from "@/store/ui";

/** Whether an agent that hit its limit or failed has a one-click way forward. */
export function needsRecovery(agent: Agent): boolean {
  return !agent.archived && (agent.rateLimited || agent.status === "error");
}

/** The same next steps as the agent view: switch account after a rate limit, resume or retry after an error. */
export function RecoveryActions({ agent, compact = false }: { agent: Agent; compact?: boolean }) {
  const label = (text: string) => <span className={compact ? "hidden @xl:inline" : undefined}>{text}</span>;
  return (
    // The card or row behind this opens the agent when clicked.
    <div
      className="flex items-center gap-1.5"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {agent.rateLimited && agent.provider !== "custom" && (
        <Button
          size="xs"
          variant="warn"
          title="Move this agent to another account"
          aria-label={`Switch account: ${agent.title}`}
          onClick={() => useUi.getState().setMoveAgent(agent)}
        >
          <Repeat className="!h-3.5 !w-3.5" />
          {label("Switch account")}
        </Button>
      )}
      {agent.status === "error" &&
        (agent.running ? (
          <Button
            size="xs"
            variant="warn"
            title="Ask the agent to carry on"
            aria-label={`Retry: ${agent.title}`}
            onClick={() => void attempt("Couldn't send", () => api.sendPrompt(agent.id, CONTINUE_PROMPT))}
          >
            <RotateCcw className="!h-3.5 !w-3.5" />
            {label("Retry")}
          </Button>
        ) : (
          <Button
            size="xs"
            variant="warn"
            title="Start this agent again where it stopped"
            aria-label={`Resume: ${agent.title}`}
            onClick={() => void resumeAgent(agent)}
          >
            <Play className="!h-3.5 !w-3.5" />
            {label("Resume")}
          </Button>
        ))}
    </div>
  );
}
