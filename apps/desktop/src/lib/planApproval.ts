import type { PermissionOption, TimelineItem } from "./types";

/** An approval of a plan (Claude's ExitPlanMode): the permission item carries the plan text. */
type PlanApprovalItem = Extract<TimelineItem, { kind: "permission" }> & { plan: string };

export function isPlanApproval(item: TimelineItem): item is PlanApprovalItem {
  return item.kind === "permission" && typeof item.plan === "string" && item.plan.length > 0;
}

export interface PlanChoice {
  option: PermissionOption;
  /** Short button label. */
  label: string;
  /** What the choice does, for the tooltip. */
  hint: string;
}

/** Wording per claude-agent-acp option id; anything it adds later falls back to its own name. */
const LABELS: Record<string, { label: string; hint: string }> = {
  "exit-plan-accept-edits": { label: "Approve · auto-accept edits", hint: "Run the plan and accept file edits without asking." },
  "exit-plan-default": { label: "Approve · review each edit", hint: "Run the plan; you approve every edit as it comes." },
  "exit-plan-auto": { label: "Approve · auto mode", hint: "Run the plan in auto mode." },
  "exit-plan-bypass": { label: "Approve · bypass permissions", hint: "Run the plan without any permission prompts." },
  "exit-plan-clear-accept-edits": { label: "Fresh context · auto-accept edits", hint: "Clear the conversation, then run the plan and accept edits." },
  "exit-plan-clear-auto": { label: "Fresh context · auto mode", hint: "Clear the conversation, then run the plan in auto mode." },
  "exit-plan-clear-bypass": { label: "Fresh context · bypass permissions", hint: "Clear the conversation, then run the plan without permission prompts." },
};

const isReject = (o: PermissionOption) => o.kind === "reject_once" || o.kind === "reject_always";

/**
 * The choices of a plan approval: the ways to approve, in the order the adapter offers them
 * (the first is its preferred one), and the one that sends the agent back to planning.
 */
export function planChoices(item: { options: PermissionOption[] }): { approve: PlanChoice[]; keepPlanning: PermissionOption | undefined } {
  const approve = item.options
    .filter((o) => !isReject(o))
    .map((option) => {
      const known = LABELS[option.id];
      return { option, label: known?.label ?? option.name, hint: known?.hint ?? option.name };
    });
  return { approve, keepPlanning: item.options.find(isReject) };
}

/** What a resolved plan approval says: which way it went, e.g. "Approved · auto-accept edits". */
export function planResolution(item: { options: PermissionOption[]; resolution: string | null }): {
  text: string;
  outcome: "approved" | "kept_planning" | "cancelled";
} {
  const chosen = item.options.find((o) => o.id === item.resolution);
  if (!chosen) return { text: "Cancelled", outcome: "cancelled" };
  if (isReject(chosen)) return { text: "Kept planning", outcome: "kept_planning" };
  const label = LABELS[chosen.id]?.label ?? chosen.name;
  return { text: label.startsWith("Approve") ? label.replace(/^Approve ·/, "Approved ·") : `Approved · ${label}`, outcome: "approved" };
}

/** The plan's first heading or line, for a compact summary. */
export function planTitle(plan: string): string {
  for (const raw of plan.split("\n")) {
    const line = raw.replace(/^#+\s*/, "").replace(/[*_`]/g, "").trim();
    if (line) return line.length > 90 ? `${line.slice(0, 89)}…` : line;
  }
  return "Plan";
}
