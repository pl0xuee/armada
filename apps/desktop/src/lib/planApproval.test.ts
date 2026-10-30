import { describe, expect, it } from "vitest";
import { isPlanApproval, planChoices, planResolution, planTitle } from "./planApproval";
import type { PermissionOption, TimelineItem } from "./types";

// What claude-agent-acp offers for ExitPlanMode.
const OPTIONS: PermissionOption[] = [
  { id: "exit-plan-accept-edits", name: "Yes, auto-accept edits", kind: "allow_always" },
  { id: "exit-plan-default", name: "Yes, manually approve edits", kind: "allow_once" },
  { id: "reject", name: "No, keep planning", kind: "reject_once" },
];

const permission = (extra: Record<string, unknown> = {}): TimelineItem =>
  ({
    id: "i1", agentId: "a", seq: 1, ts: 1, kind: "permission", requestId: "r", title: "Ready to code?",
    toolKind: "other", command: null, diffs: [], options: OPTIONS, resolution: null, ...extra,
  }) as TimelineItem;

describe("planApproval", () => {
  it("only a permission with plan text is a plan approval", () => {
    expect(isPlanApproval(permission({ plan: "# Plan" }))).toBe(true);
    expect(isPlanApproval(permission())).toBe(false);
    expect(isPlanApproval(permission({ plan: "" }))).toBe(false);
  });

  it("labels the approvals by option id and finds the way back to planning", () => {
    const { approve, keepPlanning } = planChoices({ options: OPTIONS });
    expect(approve.map((c) => c.label)).toEqual(["Approve · auto-accept edits", "Approve · review each edit"]);
    expect(keepPlanning?.id).toBe("reject");
  });

  it("falls back to the adapter's own name for an option it doesn't know", () => {
    const { approve } = planChoices({ options: [{ id: "exit-plan-new", name: "Yes, do it", kind: "allow_once" }] });
    expect(approve[0].label).toBe("Yes, do it");
  });

  it("summarises how it was resolved", () => {
    expect(planResolution({ options: OPTIONS, resolution: "exit-plan-default" })).toEqual({ text: "Approved · review each edit", outcome: "approved" });
    expect(planResolution({ options: OPTIONS, resolution: "reject" })).toEqual({ text: "Kept planning", outcome: "kept_planning" });
    expect(planResolution({ options: OPTIONS, resolution: "cancelled" })).toEqual({ text: "Cancelled", outcome: "cancelled" });
  });

  it("titles a plan by its first heading", () => {
    expect(planTitle("\n## Add **dark** mode\n- step")).toBe("Add dark mode");
    expect(planTitle("  ")).toBe("Plan");
  });
});
