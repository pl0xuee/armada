import { describe, expect, it } from "vitest";
import { seedAgents } from "@/lib/mock-data";
import type { Agent, TimelineItem } from "@/lib/types";
import { useApp } from "@/store/app";
import { agentNumbers, itemsOf } from "./AgentGrid";

const msg = (agentId: string, text: string): TimelineItem => ({
  id: `${agentId}-m`,
  agentId,
  seq: 1,
  ts: 1,
  kind: "agent_message",
  text,
});

/** How often a component subscribed with `select` would re-render while `act` runs (zustand compares with Object.is). */
function rendersFor<T>(select: (s: ReturnType<typeof useApp.getState>) => T, act: () => void): number {
  let last = select(useApp.getState());
  let n = 0;
  const off = useApp.subscribe((s) => {
    const next = select(s);
    if (!Object.is(next, last)) n++;
    last = next;
  });
  act();
  off();
  return n;
}

describe("AgentGrid timeline subscription", () => {
  const [a, b] = seedAgents().slice(0, 2);
  const stream = () =>
    useApp
      .getState()
      .applyEvents([
        { type: "text_delta", agentId: b.id, itemId: `${b.id}-m`, field: "text", delta: " more", offset: 4 },
      ]);
  const setup = () =>
    useApp.setState({
      agents: { [a.id]: a, [b.id]: b },
      items: { [a.id]: [msg(a.id, "one")], [b.id]: [msg(b.id, "two!")] },
    });

  it("a column does not re-render when another agent streams", () => {
    setup();
    expect(rendersFor(itemsOf(a.id), stream)).toBe(0);
  });

  it("a column re-renders when its own agent streams", () => {
    setup();
    expect(rendersFor(itemsOf(b.id), stream)).toBe(1);
  });

  it("(the old whole-map subscription re-rendered the grid for every streamed frame)", () => {
    setup();
    expect(rendersFor((s) => s.items, stream)).toBe(1);
  });
});

describe("agentNumbers", () => {
  const mk = (id: string, over: Partial<Agent> = {}): Agent => ({ ...seedAgents()[0], id, ...over });

  it("numbers agents of the same kind and leaves single ones alone", () => {
    const n = agentNumbers([
      mk("c1", { provider: "claude", accountId: "x" }),
      mk("c2", { provider: "claude", accountId: "x" }),
      mk("x1", { provider: "codex", accountId: "y" }),
    ]);
    expect(n.get("c1")).toBe("#1");
    expect(n.get("c2")).toBe("#2");
    expect(n.has("x1")).toBe(false);
  });
});
