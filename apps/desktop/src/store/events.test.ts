import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KvistcodeEvent } from "@/lib/types";

let push: (e: KvistcodeEvent) => void = () => {};
vi.mock("@/lib/api", () => ({
  onKvistcodeEvent: (cb: (e: KvistcodeEvent) => void) => {
    push = cb;
    return Promise.resolve(() => {});
  },
}));
const applyEvents = vi.fn();
vi.mock("./app", () => ({ useApp: { getState: () => ({ agents: {}, applyEvents }), setState: vi.fn() } }));
vi.mock("./ui", () => ({ useUi: { getState: () => ({}), setState: vi.fn() } }));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { dismiss: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() }),
}));
vi.mock("@/lib/actions", () => ({ switchAccount: vi.fn(), switchCandidates: () => [] }));
vi.mock("@/lib/terminal-bus", () => ({ routeTerminalOutput: vi.fn(), routeTerminalExit: vi.fn() }));
vi.mock("@/lib/scheduleEvents", () => ({ publishScheduleEvent: vi.fn() }));
vi.mock("@/lib/helpers", () => ({ tileNeighbour: () => null }));

const { connectEvents } = await import("./events");

const delta = (offset: number): KvistcodeEvent => ({
  type: "text_delta",
  agentId: "a",
  itemId: "i",
  field: "text",
  delta: "x",
  offset,
});

/** A minimal `document` with a settable `hidden` flag and a visibilitychange listener list. */
function fakeDocument() {
  const listeners = new Set<() => void>();
  const doc = {
    hidden: false,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    show() {
      doc.hidden = false;
      for (const fn of listeners) fn();
    },
    listeners,
  };
  return doc;
}

describe("connectEvents batching", () => {
  let doc: ReturnType<typeof fakeDocument>;
  let off: () => void;
  beforeEach(async () => {
    vi.useFakeTimers();
    applyEvents.mockClear();
    doc = fakeDocument();
    vi.stubGlobal("document", doc);
    // Frames never run (as in a hidden window): only the timer fallback delivers events.
    let id = 0;
    vi.stubGlobal("requestAnimationFrame", () => ++id);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    off = connectEvents();
    await Promise.resolve();
  });
  afterEach(() => {
    off();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("applies a visible window's events within a fraction of a second", () => {
    push(delta(0));
    push(delta(1));
    vi.advanceTimersByTime(130);
    expect(applyEvents).toHaveBeenCalledTimes(1);
    expect(applyEvents.mock.calls[0][0]).toHaveLength(2);
  });

  it("applies a hidden window's events in one coarse batch a second", () => {
    doc.hidden = true;
    for (let i = 0; i < 40; i++) {
      push(delta(i));
      vi.advanceTimersByTime(20);
    }
    // 800 ms of streaming: nothing rendered yet.
    expect(applyEvents).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(applyEvents).toHaveBeenCalledTimes(1);
    expect(applyEvents.mock.calls[0][0]).toHaveLength(40);
  });

  it("shows everything that arrived while hidden as soon as the window is visible again", () => {
    doc.hidden = true;
    push(delta(0));
    push(delta(1));
    expect(applyEvents).not.toHaveBeenCalled();
    doc.show();
    expect(applyEvents).toHaveBeenCalledTimes(1);
    expect(applyEvents.mock.calls[0][0]).toHaveLength(2);
    // The pending timer was cancelled with the flush.
    vi.advanceTimersByTime(2000);
    expect(applyEvents).toHaveBeenCalledTimes(1);
  });

  it("stops listening for visibility changes when disconnected", () => {
    expect(doc.listeners.size).toBe(1);
    off();
    expect(doc.listeners.size).toBe(0);
    off = () => {};
  });
});
