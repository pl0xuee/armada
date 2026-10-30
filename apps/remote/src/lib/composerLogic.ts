/** Pure helpers behind the composer: pending-prompt reconciliation and the "/" command picker. */
import { commandRank } from "@shared/slashCommands";
import type { PendingPrompt } from "./store";
import type { Agent, QueuedPrompt, RemoteEvent, SlashCommand, TimelineItem } from "./types";

const same = (a: string, b: string) => a.trim() === b.trim();

/**
 * Drop optimistic prompts the server has confirmed: either it appeared in the
 * timeline (it ran) or in the agent's queue (it's waiting behind a turn).
 * Returns the same array when nothing changed.
 */
export function reconcilePending(pending: PendingPrompt[], items: TimelineItem[], queue: QueuedPrompt[] | undefined): PendingPrompt[] {
  if (!pending.length) return pending;
  const remaining = pending.slice();
  for (const m of items) {
    if (m.kind !== "user_message") continue;
    const idx = remaining.findIndex((p) => !p.failed && p.afterSeq < m.seq && same(p.text, m.text));
    if (idx >= 0) remaining.splice(idx, 1);
  }
  for (const q of queue ?? []) {
    const idx = remaining.findIndex((p) => p.sent && !p.failed && same(p.text, q.text));
    if (idx >= 0) remaining.splice(idx, 1);
  }
  return remaining.length === pending.length ? pending : remaining;
}

/** The command being typed: text is "/" + name with no whitespace yet. */
export function slashQuery(text: string): string | null {
  const m = /^\/([^\s/]*)$/.exec(text);
  return m ? m[1].toLowerCase() : null;
}

/** Commands matching the query: name prefix first, then substring matches in name or description. */
export function filterCommands(commands: SlashCommand[], query: string, limit = 8): SlashCommand[] {
  const q = query.toLowerCase();
  const prefix: SlashCommand[] = [];
  const initials: SlashCommand[] = [];
  const rest: SlashCommand[] = [];
  for (const c of commands) {
    const name = c.name.replace(/^\//, "").toLowerCase();
    const rank = commandRank(name, q);
    if (rank === 0) prefix.push(c);
    // "rc" finds remote-control, as in Claude Code.
    else if (rank === 1) initials.push(c);
    else if (q && (rank === 2 || (c.description ?? "").toLowerCase().includes(q))) rest.push(c);
  }
  return [...prefix, ...initials, ...rest].slice(0, limit);
}

/** Composer text after picking a command. */
export function insertCommand(cmd: SlashCommand): string {
  return `/${cmd.name.replace(/^\//, "")} `;
}

/**
 * Merge consecutive text deltas for the same field into one when their
 * offsets chain, so a frame's worth of streamed chunks costs one update.
 * Other events keep their order.
 */
export function coalesceDeltas(events: RemoteEvent[]): RemoteEvent[] {
  const out: RemoteEvent[] = [];
  for (const ev of events) {
    const prev = out[out.length - 1];
    if (
      ev.type === "text_delta" &&
      prev?.type === "text_delta" &&
      prev.agentId === ev.agentId &&
      prev.itemId === ev.itemId &&
      prev.field === ev.field &&
      prev.offset + prev.delta.length === ev.offset
    ) {
      out[out.length - 1] = { ...prev, delta: prev.delta + ev.delta };
    } else out.push(ev);
  }
  return out;
}

/**
 * The composer's placeholder in the desktop's wording for each state (waiting
 * on an approval or a question, working, just finished, ready), as candidates
 * from the full desktop sentence down to a short one: a phone's box may only
 * fit the short one. Every busy state ends on the same "Queue a message…".
 * Pick with `pickPlaceholder`.
 */
export function composerPlaceholders(
  agent: Pick<Agent, "status" | "unread" | "availableCommands">,
  name: string,
  /** The agent is waiting on a question: typing queues a message, it doesn't answer it. */
  asking = false,
): string[] {
  if (asking) return ["Answer above, or queue a message to run after this turn…", "Answer above, or queue a message…", "Answer above, or queue…"];
  if (agent.status === "needs_permission") {
    return ["Waiting for you above. Queue a message to run after this turn…", "Waiting for you above. Queue a message…", "Queue a message…"];
  }
  if (agent.status === "working" || agent.status === "starting") {
    return [`${name} is working. Queue a follow-up message…`, `${name} is working. Queue a message…`, "Queue a message…"];
  }
  if (agent.status === "idle" && agent.unread) return ["Done. Reply, or start something new…", "Done. Reply…"];
  return (agent.availableCommands?.length ?? 0) > 0 ? [`Message ${name}…  / for commands`, `Message ${name}…`] : [`Message ${name}…`];
}

/** The longest candidate that fits on one line (the shortest if none does). */
export function pickPlaceholder(candidates: string[], fits: (text: string) => boolean): string {
  return candidates.find(fits) ?? candidates[candidates.length - 1];
}
