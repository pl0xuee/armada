import type { TimelineItem } from "@/lib/types";
import { runText } from "../timeline/messageFlow";

/**
 * The agent's latest piece of writing, for the compare columns: the newest text message together with the
 * messages right before it that the conversation shows as one text (the backend cuts a message in two when
 * a sub-agent's call lands in the middle, which sits inside its own card and shows nothing between the halves).
 * `streaming`: that text is still the last thing on the timeline.
 */
export function lastAnswer(items: readonly TimelineItem[]): { text: string | null; streaming: boolean } {
  const isText = (it: TimelineItem | undefined): it is Extract<TimelineItem, { kind: "agent_message" }> =>
    it?.kind === "agent_message" && !(it.images && it.images.length > 0);
  let end = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "agent_message" && it.text.trim()) {
      end = i;
      break;
    }
  }
  if (end < 0) return { text: null, streaming: false };
  const parts: TimelineItem[] = [items[end]];
  if (isText(items[end])) {
    for (let i = end - 1; i >= 0; i--) {
      const it = items[i];
      // A sub-agent's own calls render inside its card: nothing visible between the halves.
      if (it.kind === "tool_call" && it.parentToolCallId) continue;
      if (!isText(it)) break;
      parts.unshift(it);
    }
  }
  return { text: runText(parts), streaming: end === items.length - 1 };
}
