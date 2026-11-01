import { describe, expect, it } from "vitest";
import { busySendPlan } from "./sendOptions";

describe("busySendPlan", () => {
  const steer = { steerable: true };
  const plain = { steerable: false };
  it("is just a send while idle", () => {
    expect(busySendPlan(steer, "hi", false)).toEqual({ mode: undefined, note: null, canToggle: false });
  });
  it("delivers into the running turn when the agent can take it, and lets you queue instead", () => {
    const p = busySendPlan(steer, "also add tests", true);
    expect(p.mode).toBe("deliver");
    expect(p.canToggle).toBe(true);
    expect(p.note).toBe("Read at its next step.");
    const q = busySendPlan(steer, "also add tests", true, "queue");
    expect(q.mode).toBe("queue");
    expect(q.note).toBe("Waits for this turn to end.");
  });
  it("queues for agents that cannot take messages mid-turn, with no choice to make", () => {
    const p = busySendPlan(plain, "hi", true, "deliver");
    expect(p).toMatchObject({ mode: "queue", canToggle: false });
  });
  it("queues slash commands whatever the agent can do", () => {
    const p = busySendPlan(steer, "  /review", true, "deliver");
    expect(p).toMatchObject({ mode: "queue", canToggle: false });
    expect(p.note).toBe("Commands run after this turn.");
  });
});
