import { describe, expect, it } from "vitest";
import { pickTarget, type Candidate, type NodeLike } from "./dictation";

const node = (...inside: unknown[]): NodeLike => ({ contains: (o) => inside.includes(o) });

describe("pickTarget", () => {
  const btnA = {};
  const btnB = {};
  const input = {};
  const composer = (id: string, el: unknown, scope: NodeLike | null, visible = true): Candidate => ({
    id,
    el,
    scope,
    visible,
  });

  it("prefers the target whose region holds the focused element", () => {
    const a = composer("a", btnA, node(btnA, input));
    const b = composer("b", btnB, node(btnB));
    expect(pickTarget([a, b], input, null)).toBe("a");
  });

  it("falls back to the topmost dialog's target", () => {
    const dlg = node(btnB);
    const a = composer("a", btnA, null);
    const b = composer("b", btnB, dlg, false);
    expect(pickTarget([a, b], null, dlg)).toBe("b");
  });

  it("does not dictate behind an open dialog with no target", () => {
    const a = composer("a", btnA, null);
    expect(pickTarget([a], null, node())).toBeNull();
  });

  it("uses the last visible composer otherwise", () => {
    const a = composer("a", btnA, null);
    const b = composer("b", btnB, null, false);
    expect(pickTarget([a, b], null, null)).toBe("a");
  });
});
