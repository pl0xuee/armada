import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Agent } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

/** Context usage above which "Compact context" is suggested. */
export const COMPACT_SUGGEST_RATIO = 0.8;

export function canCompact(agent: Agent): boolean {
  return agent.availableCommands.some((c) => c.name === "compact");
}

export function contextRatio(agent: Agent): number {
  return agent.contextSize ? (agent.contextUsed ?? 0) / agent.contextSize : 0;
}

/** Sends the provider's /compact command (queues if a turn is running). */
export async function compactContext(agent: Agent) {
  const busy = agent.status === "working" || agent.status === "starting" || agent.status === "needs_permission";
  try {
    await api.sendPrompt(agent.id, "/compact");
    toast.success(busy ? "Compact queued" : "Compacting context", {
      description: busy ? "Runs right after the current turn." : "The conversation is summarized to free up context.",
    });
  } catch (e) {
    toast.error("Couldn't compact the context", { description: errorMessage(e) });
  }
}
