import { describe, expect, it } from "vitest";
import { clockTime, fullDate, fullDateTime, relativeTime } from "./format";

const SAMPLES = [
  Date.UTC(2024, 0, 1, 0, 0, 0),
  Date.UTC(2024, 2, 4, 13, 5, 9),
  Date.UTC(2024, 11, 31, 23, 59, 59),
  Date.UTC(2026, 6, 15, 9, 7, 3),
  1_700_000_000_000,
  0,
];

describe("date formatting", () => {
  it("fullDate matches toLocaleString with the same options", () => {
    for (const ts of SAMPLES) {
      expect(fullDate(ts)).toBe(
        new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
      );
    }
  });

  it("fullDateTime matches the default toLocaleString", () => {
    for (const ts of SAMPLES) expect(fullDateTime(ts)).toBe(new Date(ts).toLocaleString());
  });

  it("clockTime matches toLocaleTimeString", () => {
    for (const ts of SAMPLES) {
      expect(clockTime(ts)).toBe(new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
    }
  });

  it("relativeTime falls back to the short date after a week", () => {
    const now = Date.UTC(2026, 6, 15, 12);
    for (const ts of SAMPLES.slice(0, 3)) {
      expect(relativeTime(ts, now)).toBe(
        new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      );
    }
  });

  it("prints Invalid Date instead of throwing, like toLocaleString", () => {
    expect(fullDate(NaN)).toBe("Invalid Date");
    expect(fullDateTime(NaN)).toBe("Invalid Date");
    expect(clockTime(NaN)).toBe("Invalid Date");
    expect(relativeTime(NaN, 0)).toBe(new Date(NaN).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  });

  it("is stable across repeated calls (cached formatter)", () => {
    const a = fullDate(SAMPLES[1]);
    expect(fullDate(SAMPLES[1])).toBe(a);
    expect(fullDate(SAMPLES[2])).not.toBe(a);
  });
});
