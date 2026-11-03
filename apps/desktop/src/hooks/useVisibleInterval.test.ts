import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setVisibleInterval } from "./useVisibleInterval";

function fakeTarget() {
  const map = new Map<string, Set<() => void>>();
  return {
    addEventListener: (t: string, cb: () => void) => void (map.get(t) ?? map.set(t, new Set()).get(t)!).add(cb),
    removeEventListener: (t: string, cb: () => void) => void map.get(t)?.delete(cb),
    fire: (t: string) => map.get(t)?.forEach((cb) => cb()),
    count: () => [...map.values()].reduce((n, s) => n + s.size, 0),
  };
}

describe("setVisibleInterval", () => {
  let win: ReturnType<typeof fakeTarget>;
  let doc: ReturnType<typeof fakeTarget> & { hidden: boolean; documentElement: { dataset: Record<string, string> } };
  beforeEach(() => {
    vi.useFakeTimers();
    win = fakeTarget();
    doc = Object.assign(fakeTarget(), { hidden: false, documentElement: { dataset: {} as Record<string, string> } });
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("ticks while focused", () => {
    const fn = vi.fn();
    const stop = setVisibleInterval(fn, 1000);
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);
    stop();
  });

  it("skips ticks while blurred or hidden, then runs once on return", () => {
    const fn = vi.fn();
    const stop = setVisibleInterval(fn, 1000);
    doc.documentElement.dataset.window = "blurred";
    win.fire("blur");
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
    delete doc.documentElement.dataset.window;
    win.fire("focus");
    vi.advanceTimersByTime(0);
    expect(fn).toHaveBeenCalledTimes(1);
    doc.hidden = true;
    doc.fire("visibilitychange");
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
  });

  it("removes its listeners and timers when stopped", () => {
    const fn = vi.fn();
    const stop = setVisibleInterval(fn, 1000);
    stop();
    expect(win.count() + doc.count()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });
});
