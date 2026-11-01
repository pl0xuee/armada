import { describe, expect, it } from "vitest";
import { markTourSeen, resetTourSeen, shouldAutoShowTour, TOUR_KEY, tourSeen, type TourContext } from "./tour";

class MemoryStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}
const broken = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
  removeItem: () => {
    throw new Error("denied");
  },
};

const ctx = (o: Partial<TourContext> = {}): TourContext => ({ onboarded: true, seen: false, automated: false, forced: false, ...o });

describe("tour flag", () => {
  it("uses its own key, not a legacy armada.* one", () => {
    expect(TOUR_KEY).toBe("kvistcode.tour.v1");
  });
  it("is unseen until marked, and stays seen", () => {
    const s = new MemoryStorage();
    expect(tourSeen(s)).toBe(false);
    markTourSeen(s);
    expect(s.m.get(TOUR_KEY)).toBe("1");
    expect(tourSeen(s)).toBe(true);
    resetTourSeen(s);
    expect(tourSeen(s)).toBe(false);
  });
  it("counts as seen when storage is unreadable, and never throws", () => {
    expect(tourSeen(broken)).toBe(true);
    expect(() => markTourSeen(broken)).not.toThrow();
    expect(() => resetTourSeen(broken)).not.toThrow();
  });
});

describe("shouldAutoShowTour", () => {
  it("shows once for a new user after setup and for an existing user on first launch", () => {
    expect(shouldAutoShowTour(ctx())).toBe(true);
  });
  it("does not show again once seen", () => {
    expect(shouldAutoShowTour(ctx({ seen: true }))).toBe(false);
  });
  it("never covers onboarding", () => {
    expect(shouldAutoShowTour(ctx({ onboarded: false }))).toBe(false);
    expect(shouldAutoShowTour(ctx({ onboarded: false, forced: true }))).toBe(false);
  });
  it("stays out of the way of scripted sessions unless forced", () => {
    expect(shouldAutoShowTour(ctx({ automated: true }))).toBe(false);
    expect(shouldAutoShowTour(ctx({ automated: true, forced: true }))).toBe(true);
    expect(shouldAutoShowTour(ctx({ seen: true, forced: true }))).toBe(true);
  });
});
