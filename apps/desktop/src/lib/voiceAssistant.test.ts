import { describe, expect, it } from "vitest";
import {
  beginVa,
  formatCost,
  formatElapsed,
  initialVa,
  isLive,
  reduceVa,
  MAX_CAPTIONS,
  PHASE_LABEL,
} from "./voiceAssistant";

describe("reduceVa", () => {
  it("tracks state and clears levels when the session ends", () => {
    let s = beginVa();
    s = reduceVa(s, { type: "state", state: "listening", message: null });
    s = reduceVa(s, { type: "level", input: 0.4, output: 0 });
    expect(s.phase).toBe("listening");
    expect(isLive(s)).toBe(true);
    s = reduceVa(s, { type: "ended", reason: "ended", error: false });
    expect(s.phase).toBe("off");
    expect(s.inputLevel).toBe(0);
    expect(isLive(s)).toBe(false);
  });

  it("keeps an error visible with its message", () => {
    const s = reduceVa(beginVa(), { type: "ended", reason: "OpenAI rejected the API key.", error: true });
    expect(s.phase).toBe("error");
    expect(s.message).toMatch(/rejected/);
    expect(isLive(s)).toBe(false);
  });

  it("updates a caption in place and keeps only the latest few", () => {
    let s = beginVa();
    s = reduceVa(s, { type: "caption", role: "user", itemId: "a", text: "hel", done: false });
    s = reduceVa(s, { type: "caption", role: "user", itemId: "a", text: "hello", done: true });
    expect(s.captions).toEqual([{ role: "user", itemId: "a", text: "hello", done: true }]);
    for (let i = 0; i < 10; i++)
      s = reduceVa(s, { type: "caption", role: "assistant", itemId: `i${i}`, text: "x", done: true });
    expect(s.captions).toHaveLength(MAX_CAPTIONS);
    expect(s.captions.at(-1)?.itemId).toBe("i9");
  });

  it("appends actions and ignores navigate", () => {
    let s = reduceVa(initialVa, {
      type: "action",
      id: "1",
      kind: "start_agent",
      summary: "Started",
      agentId: "a",
      ok: true,
    });
    expect(s.actions).toHaveLength(1);
    s = reduceVa(s, { type: "navigate", view: "inbox", agentId: null });
    expect(s.actions).toHaveLength(1);
  });

  it("pausing (mute, pause listening, go to sleep) keeps the session live but silent", () => {
    let s = reduceVa(beginVa(), { type: "state", state: "listening", message: null });
    s = reduceVa(s, { type: "level", input: 0.9, output: 0.1 });
    s = reduceVa(s, { type: "notice", message: "hiccup" });
    s = reduceVa(s, { type: "state", state: "paused", message: null });
    expect(s.phase).toBe("paused");
    expect(isLive(s)).toBe(true);
    expect(s.inputLevel).toBe(0);
    expect(s.outputLevel).toBe(0);
    expect(s.notice).toBeNull();
    // A late level event cannot make a paused panel look like it is hearing something.
    expect(reduceVa(s, { type: "level", input: 0.9, output: 0.4 }).inputLevel).toBe(0);
    expect(PHASE_LABEL.paused).toBe("Paused");
    // Unmuting reconnects, then listens again.
    s = reduceVa(s, { type: "state", state: "connecting", message: null });
    s = reduceVa(s, { type: "state", state: "listening", message: null });
    expect(reduceVa(s, { type: "level", input: 0.5, output: 0 }).inputLevel).toBe(0.5);
  });

  it("a paused session can still end", () => {
    const s = reduceVa({ ...beginVa(), phase: "paused" }, { type: "ended", reason: "ended", error: false });
    expect(s.phase).toBe("off");
  });
});

describe("formatting", () => {
  it("formats elapsed time", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(65)).toBe("1:05");
    expect(formatElapsed(600)).toBe("10:00");
  });
  it("formats cost", () => {
    expect(formatCost(0.001)).toBe("<$0.01");
    expect(formatCost(0.456)).toBe("$0.46");
    expect(formatCost(12.3)).toBe("$12.30");
  });
});
