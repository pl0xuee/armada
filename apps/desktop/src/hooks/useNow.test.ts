import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture what useNow hands to useSyncExternalStore, so the store can be driven without a DOM.
let store: { subscribe: (cb: () => void) => () => void; getSnapshot: () => number };
vi.mock("react", () => ({
  useSyncExternalStore: (subscribe: (cb: () => void) => () => void, getSnapshot: () => number) => {
    store = { subscribe, getSnapshot };
    return getSnapshot();
  },
}));
const stop = vi.fn();
vi.mock("./useVisibleInterval", () => ({ setVisibleInterval: vi.fn(() => stop) }));

describe("useNow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.resetModules();
    stop.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("starts from the current time again when the first subscriber comes back after the ticker stopped", async () => {
    const { useNow } = await import("./useNow");
    useNow();
    const off = store.subscribe(() => {});
    off();
    expect(stop).toHaveBeenCalledTimes(1);

    // The view was away for an hour: timestamps must not be drawn against the old reading.
    vi.setSystemTime(1_000_000 + 3_600_000);
    expect(useNow()).toBe(1_000_000);
    const back = store.subscribe(() => {});
    expect(store.getSnapshot()).toBe(1_000_000 + 3_600_000);
    back();
  });

  it("keeps one shared reading while subscribers overlap", async () => {
    const { useNow } = await import("./useNow");
    useNow();
    const a = store.subscribe(() => {});
    vi.setSystemTime(1_000_000 + 5_000);
    const b = store.subscribe(() => {});
    expect(store.getSnapshot()).toBe(1_000_000);
    a();
    b();
  });
});
