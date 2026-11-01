import { HoldBody } from "@/components/BudgetHold";
import { holdTitle, type HoldLike } from "@/lib/budgetHold";
import type { Agent } from "@/lib/types";

/** The dock above the composer when the agent is held at a limit. */
export function BudgetHoldCard({ agent, hold }: { agent: Agent; hold: HoldLike }) {
  return (
    <section
      aria-label={holdTitle(hold)}
      role="status"
      className="mt-2 rounded-2xl border p-3 pl-3.5"
      style={{ borderColor: "color-mix(in srgb, var(--warn) 32%, var(--border))", background: "color-mix(in srgb, var(--warn) 8%, var(--bg-1))" }}
    >
      <HoldBody agent={agent} hold={hold} compact />
    </section>
  );
}
