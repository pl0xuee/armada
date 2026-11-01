import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoalescedWriter, createThrottle } from "./throttle";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe("createThrottle", () => {
  it("emits the first value immediately", () => {
    const emit = vi.fn();
    createThrottle<string>(100, emit).push("a");
    expect(emit).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("holds values inside the window and delivers only the latest when it ends", () => {
    const emit = vi.fn();
    const t = createThrottle<string>(100, emit);
    t.push("a");
    vi.advanceTimersByTime(30);
    t.push("b");
    vi.advanceTimersByTime(30);
    t.push("c");
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(39);
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(emit.mock.calls).toEqual([["a"], ["c"]]);
  });

  it("emits at most once per window under a steady stream", () => {
    const emit = vi.fn();
    const t = createThrottle<number>(100, emit);
    for (let i = 0; i < 100; i++) {
      t.push(i);
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(100);
    expect(emit.mock.calls.length).toBeLessThanOrEqual(11);
    expect(emit.mock.calls.at(-1)).toEqual([99]);
  });

  it("emits immediately again once the window has passed", () => {
    const emit = vi.fn();
    const t = createThrottle<string>(100, emit);
    t.push("a");
    vi.advanceTimersByTime(250);
    t.push("b");
    expect(emit.mock.calls).toEqual([["a"], ["b"]]);
  });

  it("flush delivers at once and drops the held value", () => {
    const emit = vi.fn();
    const t = createThrottle<string>(100, emit);
    t.push("a");
    t.push("b");
    t.flush("final");
    vi.advanceTimersByTime(500);
    expect(emit.mock.calls).toEqual([["a"], ["final"]]);
  });

  it("cancel drops the held value", () => {
    const emit = vi.fn();
    const t = createThrottle<string>(100, emit);
    t.push("a");
    t.push("b");
    t.cancel();
    vi.advanceTimersByTime(500);
    expect(emit.mock.calls).toEqual([["a"]]);
  });
});

describe("createCoalescedWriter", () => {
  it("writes the latest value per key once calls stop", () => {
    const write = vi.fn();
    const w = createCoalescedWriter<string, number>(150, write);
    for (let i = 1; i <= 20; i++) {
      w.set("a", i);
      vi.advanceTimersByTime(16);
    }
    w.set("b", 7);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(write).toHaveBeenCalledTimes(1);
    expect([...write.mock.calls[0][0]]).toEqual([
      ["a", 20],
      ["b", 7],
    ]);
  });

  it("flush writes immediately and leaves nothing for the timer", () => {
    const write = vi.fn();
    const w = createCoalescedWriter<string, number>(150, write);
    w.set("a", 1);
    w.flush();
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("flush with nothing pending does not write", () => {
    const write = vi.fn();
    createCoalescedWriter<string, number>(150, write).flush();
    expect(write).not.toHaveBeenCalled();
  });

  it("starts a new batch after a write", () => {
    const write = vi.fn();
    const w = createCoalescedWriter<string, number>(150, write);
    w.set("a", 1);
    vi.advanceTimersByTime(150);
    w.set("a", 2);
    vi.advanceTimersByTime(150);
    expect(write.mock.calls.map((c) => [...c[0]])).toEqual([[["a", 1]], [["a", 2]]]);
  });
});
