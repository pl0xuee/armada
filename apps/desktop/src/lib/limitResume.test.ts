import { describe, expect, it } from "vitest";
import {
  clockLabel,
  isResumedBody,
  notResumingNote,
  resumeLine,
  resumesShort,
  untilLabel,
  waitingToResume,
} from "./limitResume";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A fixed "now": 2026-10-14 10:00 local time. */
const NOW = new Date(2026, 9, 14, 10, 0, 0).getTime();
const at = (d: number, h: number, m = 0) => new Date(2026, 9, 14 + d, h, m, 0).getTime();
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function agent(over: Record<string, unknown> = {}) {
  return {
    rateLimited: true,
    status: "error" as const,
    limitResetsAt: at(0, 18),
    limitResume: { state: "waiting" as const, attempts: 0, hitAt: NOW - MIN },
    ...over,
  };
}

describe("waitingToResume", () => {
  it("needs the setting, a limit-stopped agent and a waiting episode", () => {
    expect(waitingToResume(agent(), true)).toBe(true);
    expect(waitingToResume(agent(), false)).toBe(false);
    expect(waitingToResume(agent({ rateLimited: false }), true)).toBe(false);
    expect(waitingToResume(agent({ status: "working" }), true)).toBe(false);
    expect(waitingToResume(agent({ limitResume: null }), true)).toBe(false);
    expect(waitingToResume(agent({ limitResume: { state: "cancelled", attempts: 0, hitAt: 0 } }), true)).toBe(false);
    expect(waitingToResume(agent({ limitResume: { state: "gave_up", attempts: 3, hitAt: 0 } }), true)).toBe(false);
    expect(waitingToResume(null, true)).toBe(false);
  });

  it("an agent from before the feature (no limitResume field) is not waiting", () => {
    const old = { rateLimited: true, status: "error" as const };
    expect(waitingToResume(old, true)).toBe(false);
    expect(resumesShort(old, true, NOW)).toBeNull();
    expect(resumeLine(old, true, NOW)).toBeNull();
  });
});

describe("clockLabel", () => {
  it("is just the time today", () => {
    expect(clockLabel(at(0, 18), NOW)).toBe(time(at(0, 18)));
  });
  it("adds the weekday within a week and the date beyond", () => {
    const tomorrow = clockLabel(at(1, 9), NOW);
    expect(tomorrow).toContain(time(at(1, 9)));
    expect(tomorrow.length).toBeGreaterThan(time(at(1, 9)).length);
    expect(clockLabel(at(20, 9), NOW)).toContain(",");
  });
});

describe("untilLabel", () => {
  it("counts in minutes, at minute granularity", () => {
    expect(untilLabel(NOW + 30_000, NOW)).toBe("in under a minute");
    expect(untilLabel(NOW + 61_000, NOW)).toBe("in 2 min");
    expect(untilLabel(NOW + 12 * MIN, NOW)).toBe("in 12 min");
    expect(untilLabel(NOW + 59 * MIN, NOW)).toBe("in 59 min");
  });
  it("switches to hours and days", () => {
    expect(untilLabel(NOW + HOUR, NOW)).toBe("in 1 h");
    expect(untilLabel(NOW + HOUR + 5 * MIN, NOW)).toBe("in 1 h 5 min");
    expect(untilLabel(NOW + 8 * HOUR, NOW)).toBe("in 8 h");
    expect(untilLabel(NOW + 2 * DAY, NOW)).toBe("in 2 d");
    expect(untilLabel(NOW + 2 * DAY + 3 * HOUR, NOW)).toBe("in 2 d 3 h");
  });
});

describe("resumesShort", () => {
  it("reads 'Resumes 6:00 PM' for a waiting agent", () => {
    expect(resumesShort(agent(), true, NOW)).toBe(`Resumes ${time(at(0, 18))}`);
  });
  it("says so when the time has come, or is unknown", () => {
    expect(resumesShort(agent({ limitResetsAt: NOW - MIN }), true, NOW)).toBe("Resuming…");
    expect(resumesShort(agent({ limitResetsAt: null }), true, NOW)).toBe("Resumes when it lifts");
  });
  it("is null when nothing resumes it", () => {
    expect(resumesShort(agent(), false, NOW)).toBeNull();
    expect(resumesShort(agent({ rateLimited: false }), true, NOW)).toBeNull();
  });
});

describe("resumeLine", () => {
  it("has the sentence and the countdown apart", () => {
    const line = resumeLine(agent(), true, NOW)!;
    expect(line.text).toBe(`Resuming automatically at ${time(at(0, 18))}`);
    expect(line.countdown).toBe("in 8 h");
    expect(line.tries).toBeNull();
  });
  it("counts down as time passes", () => {
    const a = agent({ limitResetsAt: NOW + 12 * MIN });
    expect(resumeLine(a, true, NOW)!.countdown).toBe("in 12 min");
    expect(resumeLine(a, true, NOW + 5 * MIN)!.countdown).toBe("in 7 min");
    expect(resumeLine(a, true, NOW + 11 * MIN + 30_000)!.countdown).toBe("in under a minute");
    expect(resumeLine(a, true, NOW + 12 * MIN)!.text).toBe("Resuming automatically now");
    expect(resumeLine(a, true, NOW + 12 * MIN)!.countdown).toBeNull();
  });
  it("says which try a retry is", () => {
    const a = agent({ limitResume: { state: "waiting", attempts: 1, hitAt: NOW } });
    const line = resumeLine(a, true, NOW)!;
    expect(line.text.startsWith("Trying again automatically at")).toBe(true);
    expect(line.tries).toBe("try 2 of 3");
  });
  it("has wording for an unknown time", () => {
    expect(resumeLine(agent({ limitResetsAt: null }), true, NOW)!.text).toBe(
      "Will resume automatically when the limit lifts",
    );
  });
});

describe("notResumingNote", () => {
  it("explains a cancelled or given-up episode", () => {
    expect(notResumingNote(agent({ limitResume: { state: "cancelled", attempts: 0, hitAt: 0 } }), true)).toBe(
      "Automatic resume is off for this agent.",
    );
    expect(notResumingNote(agent({ limitResume: { state: "gave_up", attempts: 3, hitAt: 0 } }), true)).toBe(
      "Kvistcode tried 3 times and the limit is still on.",
    );
  });
  it("says nothing otherwise", () => {
    expect(notResumingNote(agent(), true)).toBeNull();
    expect(notResumingNote(agent({ limitResume: { state: "cancelled", attempts: 0, hitAt: 0 } }), false)).toBeNull();
    expect(notResumingNote(agent({ rateLimited: false }), true)).toBeNull();
  });
});

describe("isResumedBody", () => {
  it("matches the backend alert and nothing like it", () => {
    expect(isResumedBody("Resumed 3 agents after your rate limit reset")).toBe(true);
    expect(isResumedBody("Resumed Fix login after your rate limit reset")).toBe(true);
    expect(isResumedBody("Resumed work on the parser")).toBe(false);
    expect(isResumedBody("Finished")).toBe(false);
  });
});
