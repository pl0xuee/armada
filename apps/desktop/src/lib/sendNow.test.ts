import { describe, expect, it } from "vitest";
import { isSlashCommand, midTurnAwaiting, sendNowPlan } from "./sendNow";
import type { TimelineItem } from "./types";

describe("sendNowPlan", () => {
  it("runs the message when the agent is idle", () => {
    const p = sendNowPlan({ steerable: true }, "hi", false, "Claude");
    expect(p.mode).toBe("run");
    expect(p.note).toBeNull();
  });

  it("delivers into the running turn when the agent takes messages mid-turn", () => {
    const p = sendNowPlan({ steerable: true }, "also add tests", true, "Claude");
    expect(p.mode).toBe("deliver");
    expect(p.hint).toMatch(/Nothing is stopped/);
    expect(p.note).toBeNull();
  });

  it("only moves the message to the front when the agent can't, and says so", () => {
    for (const steerable of [false, undefined]) {
      const p = sendNowPlan({ steerable }, "also add tests", true, "Grok");
      expect(p.mode).toBe("front");
      expect(p.label).toBe("Run next");
      expect(p.note?.title).toBe("Grok can't take messages mid-turn here");
      expect(p.note?.description).toMatch(/Nothing was stopped/);
    }
  });

  it("puts slash commands first in line even when the agent takes messages mid-turn", () => {
    const p = sendNowPlan({ steerable: true }, "  /compact", true, "Claude");
    expect(p.mode).toBe("front");
    expect(p.note?.description).toMatch(/start of a turn/);
  });

  it("never offers anything that stops the turn", () => {
    for (const steerable of [true, false]) {
      for (const text of ["x", "/y"]) {
        const p = sendNowPlan({ steerable }, text, true, "Claude");
        expect(`${p.label} ${p.hint}`).not.toMatch(/interrupt|stops? the (current )?turn/i);
      }
    }
  });
});

describe("isSlashCommand", () => {
  it("looks at the first non-space character", () => {
    expect(isSlashCommand("/review")).toBe(true);
    expect(isSlashCommand("  /review")).toBe(true);
    expect(isSlashCommand("look at /etc")).toBe(false);
  });
});

describe("midTurnAwaiting", () => {
  let n = 0;
  const mk = (kind: string, extra: object = {}) =>
    ({ id: `i${++n}`, agentId: "a", seq: n, ts: n, kind, text: "x", ...extra }) as unknown as TimelineItem;

  it("notes mid-turn messages until the agent's next output arrives", () => {
    const user = mk("user_message");
    const mid = mk("user_message", { midTurn: true });
    expect([...midTurnAwaiting([user, mk("agent_message"), mid])]).toEqual([mid.id]);
    expect(midTurnAwaiting([user, mid, mk("tool_call")]).size).toBe(0);
    expect(midTurnAwaiting([user, mid, mk("agent_message")]).size).toBe(0);
  });

  it("keeps a run of mid-turn messages together and looks past approvals", () => {
    const a = mk("user_message", { midTurn: true });
    const b = mk("user_message", { midTurn: true });
    const perm = mk("permission");
    expect([...midTurnAwaiting([mk("user_message"), a, b, perm])].sort()).toEqual([a.id, b.id].sort());
  });

  it("never notes a normal prompt", () => {
    expect(midTurnAwaiting([mk("user_message")]).size).toBe(0);
    expect(midTurnAwaiting([]).size).toBe(0);
  });
});
