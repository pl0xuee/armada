import { describe, expect, it, vi } from "vitest";
import { renderToString } from "@/test/render";
import type { PermissionItem } from "@/lib/types";

vi.mock("react", async (importOriginal) => {
  const m = await importOriginal<typeof import("react")>();
  return { ...m, memo: (c: unknown) => c, useState: (v: unknown) => [v, () => {}], useRef: (v: unknown) => ({ current: v }), useEffect: () => {} };
});
let sending: string | undefined;
vi.mock("@/lib/store", () => ({ useStore: (sel: (s: unknown) => unknown) => sel({ resolving: sending ? { r1: sending } : {} }) }));
vi.mock("@/lib/hooks", () => ({ useNow: () => 1000 }));
vi.mock("@/lib/controller", () => ({ respondToPermission: () => Promise.resolve(true) }));
vi.mock("../Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div data-md={text} /> }));
vi.mock("../Icon", () => ({ Icon: ({ name }: { name: string }) => <i data-icon={name} />, Spinner: () => <i data-spinner /> }));
vi.mock("../DenyReasonSheet", () => ({ DenyReasonSheet: () => <div data-sheet /> }));

const { PlanApprovalCard } = await import("./PlanApproval");

const plan = (extra: Partial<PermissionItem> = {}): PermissionItem => ({
  id: "i1",
  agentId: "a",
  seq: 1,
  ts: 1000,
  kind: "permission",
  requestId: "r1",
  title: "Ready to code?",
  toolKind: "other",
  command: null,
  diffs: [],
  // What claude-agent-acp offers for ExitPlanMode.
  options: [
    { id: "exit-plan-accept-edits", name: "Yes, auto-accept edits", kind: "allow_always" },
    { id: "exit-plan-default", name: "Yes, manually approve edits", kind: "allow_once" },
    { id: "reject", name: "No, keep planning", kind: "reject_once" },
  ],
  resolution: null,
  plan: "# Cache search\n\n1. Add an LRU",
  ...extra,
});

describe("PlanApprovalCard", () => {
  it("shows the plan with a button per way to approve and one to keep planning", () => {
    sending = undefined;
    const out = renderToString(<PlanApprovalCard item={plan()} readOnly={false} />);
    expect(out).toContain('data-md="# Cache search');
    expect(out).toContain("Approve · auto-accept edits");
    expect(out).toContain("Approve · review each edit");
    expect(out).toContain("Keep planning");
    expect(out).toContain("With feedback…");
  });

  it("offers no buttons to a viewer", () => {
    sending = undefined;
    const out = renderToString(<PlanApprovalCard item={plan()} readOnly />);
    expect(out).toContain("Waiting for the owner to respond.");
    expect(out).not.toContain("Keep planning");
  });

  it("collapses to a summary of the choice once answered", () => {
    sending = undefined;
    const out = renderToString(<PlanApprovalCard item={plan({ resolution: "exit-plan-accept-edits" })} readOnly={false} />);
    expect(out).toContain("Cache search");
    expect(out).toContain("Approved · auto-accept edits");
    expect(out).not.toContain("data-md");
  });

  it("says what is being sent while the answer is on its way", () => {
    sending = "reject";
    const out = renderToString(<PlanApprovalCard item={plan()} readOnly={false} />);
    expect(out).toContain("Sending");
    expect(out).toContain("Kept planning");
  });
});
