import { describe, expect, it } from "vitest";
import { limitCopy, softClock } from "./limitBanner";
import type { Agent } from "./types";

const NOW = new Date(2026, 10, 2, 12, 0, 0).getTime();
const at = (h: number, m: number) => new Date(2026, 10, 2, h, m, 0).getTime();
const base: Pick<Agent, "rateLimited" | "status" | "limitResume" | "limitResetsAt"> = {
  rateLimited: true,
  status: "error",
  limitResume: { state: "waiting", attempts: 0, hitAt: NOW, lastAttemptAt: null, probeAt: null },
  limitResetsAt: at(15, 40),
};

describe("softClock", () => {
  it("lowercases am/pm only", () => {
    expect(softClock("3:40 PM")).toBe("3:40 pm");
    expect(softClock("Thu 9:05 AM")).toBe("Thu 9:05 am");
    expect(softClock("Nov 5, 6:00 PM")).toBe("Nov 5, 6:00 pm");
  });
});

describe("limitCopy", () => {
  it("names the real reset time while waiting to resume", () => {
    const c = limitCopy(base, true, null, NOW);
    expect(c.headline).toMatch(/^Rate limit reached\. Resumes at 3:40 ?pm$/i);
    expect(c.sub).toContain("continues by itself");
    expect(c.sub).toContain("in 3 h 40 min");
  });
  it("says it resumes when the limit lifts if no time is known", () => {
    const c = limitCopy({ ...base, limitResetsAt: null }, true, null, NOW);
    expect(c.headline).toBe("Rate limit reached. Resumes when it lifts");
  });
  it("says Resets when nothing resumes by itself", () => {
    const off = limitCopy(base, false, null, NOW);
    expect(off.headline).toMatch(/Resets at 3:40 ?pm$/i);
    expect(off.sub).toBeNull();
  });
  it("falls back to the provider's own time, then to try again later", () => {
    const none = { ...base, limitResetsAt: null, limitResume: null };
    expect(limitCopy(none, true, "Usage limit reached. Resets at 6:00 PM.", NOW).headline).toBe(
      "Rate limit reached. Resets at 6:00 PM",
    );
    expect(limitCopy(none, true, "Rate limit reached for this account.", NOW).headline).toBe(
      "Rate limit reached. Try again later",
    );
    expect(limitCopy(none, true, null, NOW).headline).toBe("Rate limit reached. Try again later");
  });
  it("explains a cancelled or given-up resume in one line", () => {
    const cancelled = { ...base, limitResume: { ...base.limitResume!, state: "cancelled" as const } };
    expect(limitCopy(cancelled, true, null, NOW).sub).toBe("Automatic resume is off for this agent.");
    const gaveUp = { ...base, limitResume: { ...base.limitResume!, state: "gave_up" as const } };
    expect(limitCopy(gaveUp, true, null, NOW).sub).toContain("tried 3 times");
  });
  it("treats a past reset time as resuming now", () => {
    const c = limitCopy({ ...base, limitResetsAt: NOW - 1000 }, true, null, NOW);
    expect(c.headline).toBe("Rate limit reached. Resuming now");
  });
});
