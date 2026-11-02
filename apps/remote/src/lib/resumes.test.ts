import { describe, expect, it } from "vitest";
import { clockLabel, resumesLabel } from "./resumes";

const NOW = new Date(2026, 9, 14, 10, 0, 0).getTime();
const at = (d: number, h: number) => new Date(2026, 9, 14 + d, h, 0, 0).getTime();
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

describe("resumesLabel", () => {
  it("is 'Resumes 6:00 PM' for a limited agent with a time", () => {
    expect(resumesLabel({ rateLimited: true, limitResetsAt: at(0, 18) }, NOW)).toBe(`Resumes ${time(at(0, 18))}`);
  });
  it("says it is about to when the time has come", () => {
    expect(resumesLabel({ rateLimited: true, limitResetsAt: NOW - 1000 }, NOW)).toBe("Resuming…");
  });
  it("is null without a time, or when not limited (older desktops, cancelled, off)", () => {
    expect(resumesLabel({ rateLimited: true, limitResetsAt: null }, NOW)).toBeNull();
    expect(resumesLabel({ rateLimited: true }, NOW)).toBeNull();
    expect(resumesLabel({ rateLimited: false, limitResetsAt: at(0, 18) }, NOW)).toBeNull();
  });
});

describe("clockLabel", () => {
  it("adds the day when it is not today", () => {
    expect(clockLabel(at(0, 18), NOW)).toBe(time(at(0, 18)));
    expect(clockLabel(at(1, 9), NOW).length).toBeGreaterThan(time(at(1, 9)).length);
  });
});
