import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "@/test/render";

vi.mock("@/components/Icon", () => ({ Icon: () => null }));
vi.mock("@/components/ui", () => ({
  Button: ({ children, disabled, className }: { children: ReactNode; disabled?: boolean; className?: string }) => (
    <button className={className} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("@/lib/phoneActions", () => ({ resolveBudgetHold: vi.fn() }));
vi.mock("@/lib/confirm", () => ({ confirmAction: vi.fn() }));
const busy: Record<string, true> = {};
vi.mock("@/lib/store", () => ({ useStore: (select: (s: unknown) => unknown) => select({ busy }) }));

const { HoldBody } = await import("./BudgetHold");
import type { Agent } from "@/lib/types";

const agent = (extra: Partial<Agent> = {}) => ({ id: "h1", projectPath: "/code/web", queuedPrompts: 0, ...extra }) as Agent;
const html = (hold: { scope: string; metric: string; spent: number; cap: number }, a = agent(), compact = false) =>
  renderToString(<HoldBody agent={a} hold={hold} compact={compact} />);

describe("HoldBody", () => {
  it("offers the same ways on as the desktop for a dollar limit", () => {
    const out = html({ scope: "agent", metric: "cost", spent: 3.08, cap: 3 });
    expect(out).toContain("Paused at a spending limit");
    expect(out).toContain("Reached its own limit: $3.08 of $3.00.");
    expect(out).toContain("Raise by $5");
    expect(out).toContain("Raise by $10");
    expect(out).toContain("Continue once");
    expect(out).toContain("Stop");
  });

  it("the dock variant has one raise step", () => {
    const out = html({ scope: "agent", metric: "cost", spent: 3.08, cap: 3 }, agent(), true);
    expect(out).toContain("Raise by $5");
    expect(out).not.toContain("Raise by $10");
  });

  it("renders a limit kind it doesn't know with a readable name and steps", () => {
    const out = html({ scope: "project", metric: "turns", spent: 41, cap: 40 });
    expect(out).toContain("Paused at a turn limit");
    expect(out).toContain("Reached this project's limit: 41 of 40 turns.");
    expect(out).toContain("Raise by 20 turns");
    expect(out).toContain("every agent in web");
  });

  it("mentions what is waiting in the queue", () => {
    expect(html({ scope: "agent", metric: "cost", spent: 4, cap: 3 }, agent({ queuedPrompts: 2 }))).toContain("2 queued messages are waiting.");
    expect(html({ scope: "agent", metric: "cost", spent: 4, cap: 3 }, agent({ queuedPrompts: 1 }))).toContain("1 queued message is waiting.");
  });

  it("disables the buttons while an answer is on its way", () => {
    busy["budget:h1"] = true;
    const out = html({ scope: "agent", metric: "cost", spent: 4, cap: 3 });
    expect(out.match(/disabled/g)).toHaveLength(4);
    delete busy["budget:h1"];
  });
});
