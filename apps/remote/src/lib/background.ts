/**
 * "Background work still running" for an agent whose own turn has ended: Workflow runs it launched
 * (and, for the conversation that is open, background sub-agents). The phone's copy of the desktop's
 * `lib/background.ts`, with the same wording: an agent in this state is not "Done" or "Idle".
 *
 * Workflow runs are read by the desktop app (`GET /api/background`, counts only); background
 * sub-agents are known only for the open conversation (the phone has its timeline) and are always
 * worded softly, because Claude gives no signal when they end.
 */
import { plural } from "./format";
import type { Agent } from "./types";

export interface BackgroundWork {
  /** Workflow runs known to be running. */
  workflows: number;
  /** Agents working / in total across those runs (0 until a report has been read). */
  working: number;
  total: number;
  /** Background sub-agents that may still be running (open conversation only). */
  subagents: number;
}

export const NO_BACKGROUND: BackgroundWork = Object.freeze({ workflows: 0, working: 0, total: 0, subagents: 0 });

export const backgroundActive = (b: BackgroundWork | undefined | null): b is BackgroundWork =>
  !!b && (b.workflows > 0 || b.subagents > 0);

/** The server's answer, cleaned: numbers only, nothing for agents with no running workflow. */
export function parseBackground(raw: unknown): Record<string, BackgroundWork> {
  const out: Record<string, BackgroundWork> = {};
  const agents = (raw as { agents?: unknown } | null)?.agents;
  if (!agents || typeof agents !== "object") return out;
  for (const [id, v] of Object.entries(agents)) {
    const x = v as Partial<Record<keyof BackgroundWork, unknown>> | null;
    const n = (k: keyof BackgroundWork) => (typeof x?.[k] === "number" && Number.isFinite(x[k]) ? Math.max(0, Math.floor(x[k] as number)) : 0);
    const b: BackgroundWork = { workflows: n("workflows"), working: n("working"), total: n("total"), subagents: 0 };
    if (b.workflows > 0) out[id] = b;
  }
  return out;
}

/**
 * What an agent has running behind its finished turn: only an idle agent can (a working one is
 * simply working, a stopped or failed one is not waiting on anything).
 */
export function backgroundOf(agent: Pick<Agent, "status" | "archived">, known: BackgroundWork | undefined): BackgroundWork {
  return agent.status === "idle" && !agent.archived && known ? known : NO_BACKGROUND;
}

/** `b` plus `subagents` background sub-agents that may be running. */
export function withSubagents(b: BackgroundWork, subagents: number): BackgroundWork {
  return subagents <= 0 || b.subagents === subagents ? b : { ...b, subagents };
}

/** Short enough for a narrow row: "Workflow 3 of 5 running". */
export function backgroundShort(b: BackgroundWork): string {
  if (b.workflows > 1) return `${b.workflows} workflows running`;
  if (b.workflows === 1) {
    if (b.total === 0) return "Workflow running";
    return b.working > 0 ? `Workflow ${b.working} of ${b.total} running` : "Workflow wrapping up";
  }
  if (b.subagents > 0) return `${plural(b.subagents, "background agent")} may be running`;
  return "";
}

/** The header pill: names what finished and what did not. */
export const backgroundPill = (b: BackgroundWork) => `Turn finished · ${backgroundShort(b)}`;

/** How an agent's status reads once background work is counted: "working" while only a workflow runs. */
export function statusWith(agent: Pick<Agent, "status">, b: BackgroundWork): { status: Agent["status"]; label: string | null } {
  return backgroundActive(b) ? { status: "working", label: backgroundShort(b) } : { status: agent.status, label: null };
}

/** The sentence for a screen reader or a tooltip. */
export function backgroundDetail(b: BackgroundWork): string {
  const parts: string[] = [];
  if (b.workflows > 0) {
    const runs = b.workflows === 1 ? "A workflow is" : `${b.workflows} workflows are`;
    parts.push(b.total > 0 ? `${runs} still running: ${b.working} of ${plural(b.total, "agent")} working.` : `${runs} still running.`);
  }
  if (b.subagents > 0)
    parts.push(`${plural(b.subagents, "background agent")} it launched may still be running (Claude doesn't say when they end).`);
  return parts.length ? `Its turn finished. ${parts.join(" ")}` : "";
}
