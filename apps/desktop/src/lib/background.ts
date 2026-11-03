// "Background work still running" for an agent whose own turn has ended: Workflow runs it launched
// and background sub-agents. Pure helpers (what counts, how it reads); the live store and the
// tracker that feeds it are in store/background.ts.
//
// What is known and what is not:
//  * A Workflow run is known: its transcript folder says running / finished (`workflow_progress`).
//  * A background sub-agent is not: Claude gives no finish signal, so it counts only while the app
//    sees signs of life (see `subagentRuns`), and is always worded softly ("may be running").
import { pluralize } from "./format";
import { workflowKey, type WorkflowCall, type WorkflowEntry } from "./workflows";

/** What the backend's "turn ended" alert starts with when work it launched is still running (core `workflow::TURN_ONLY_PREFIX`). */
export const TURN_ONLY_PREFIX = "Finished its turn.";

export interface BackgroundWork {
  /** Workflow runs known to be running. */
  workflows: number;
  /** Agents working / in total across those runs (0 until a report has been read). */
  wfWorking: number;
  wfTotal: number;
  /** Background sub-agents that may still be running (nothing tells when they end). */
  subagents: number;
}

export const NO_BACKGROUND: BackgroundWork = Object.freeze({ workflows: 0, wfWorking: 0, wfTotal: 0, subagents: 0 });

export const backgroundActive = (b: BackgroundWork) => b.workflows > 0 || b.subagents > 0;

const interned = new Map<string, BackgroundWork>();

/** The same object for the same numbers, so selectors and memo deps stay stable. */
export function backgroundOf(workflows: number, wfWorking: number, wfTotal: number, subagents: number): BackgroundWork {
  if (workflows === 0 && subagents === 0) return NO_BACKGROUND;
  const key = `${workflows}/${wfWorking}/${wfTotal}/${subagents}`;
  let b = interned.get(key);
  if (!b) {
    b = Object.freeze({ workflows, wfWorking, wfTotal, subagents });
    if (interned.size > 200) interned.clear();
    interned.set(key, b);
  }
  return b;
}

/**
 * What is running, from the agent's launched Workflow runs (their latest reports) and the count of
 * background sub-agents that may still run. A run counts only when its report says `running`: not
 * yet read, quiet ("unknown") and finished runs are not claimed.
 */
export function computeBackground(
  agentId: string,
  calls: readonly WorkflowCall[],
  entries: Readonly<Record<string, WorkflowEntry | undefined>>,
  subagents: number,
): BackgroundWork {
  let workflows = 0;
  let working = 0;
  let total = 0;
  for (const c of calls) {
    const p = entries[workflowKey(agentId, c.toolCallId)]?.progress;
    if (p?.state !== "running") continue;
    workflows += 1;
    total += p.agents.length;
    working += p.agents.filter((a) => a.status === "working").length;
  }
  return backgroundOf(workflows, working, total, subagents);
}

/** Whether a run still needs reading: it is not known to be finished or unreadable. */
export const needsWatch = (e: WorkflowEntry | undefined) => !(e?.progress?.state === "finished" || e?.failed);

/** Short enough for a narrow row: "Workflow 3 of 5 running". */
export function backgroundShort(b: BackgroundWork): string {
  if (b.workflows > 1) return `${b.workflows} workflows running`;
  if (b.workflows === 1) {
    if (b.wfTotal === 0) return "Workflow running";
    return b.wfWorking > 0 ? `Workflow ${b.wfWorking} of ${b.wfTotal} running` : "Workflow wrapping up";
  }
  if (b.subagents > 0) return `${pluralize(b.subagents, "background agent")} may be running`;
  return "";
}

/** The sentence for a tooltip: what finished, and what is still going. */
export function backgroundDetail(b: BackgroundWork): string {
  const parts: string[] = [];
  if (b.workflows > 0) {
    const runs = b.workflows === 1 ? "A workflow is" : `${b.workflows} workflows are`;
    parts.push(
      b.wfTotal > 0
        ? `${runs} still running: ${b.wfWorking} of ${pluralize(b.wfTotal, "agent")} working.`
        : `${runs} still running.`,
    );
  }
  if (b.subagents > 0)
    parts.push(
      `${pluralize(b.subagents, "background agent")} it launched may still be running (Claude doesn't say when they end).`,
    );
  return parts.length ? `Its turn finished. ${parts.join(" ")}` : "";
}

/** The header pill: names what finished and what did not. */
/** The header pill: "background" is left out ("4 agents may be running") so it fits beside the other controls. */
export const backgroundPill = (b: BackgroundWork) =>
  `Turn finished · ${backgroundShort(b).replace("background agent", "agent")}`;

/** Agents with background work, readable without React (the timeline cache keeps their items). */
const activeIds = new Set<string>();
export const hasBackgroundWork = (agentId: string) => activeIds.has(agentId);
export function setBackgroundWork(agentId: string, on: boolean) {
  if (on) activeIds.add(agentId);
  else activeIds.delete(agentId);
}
