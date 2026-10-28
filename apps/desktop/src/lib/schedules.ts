// Pure helpers for schedules: next-run computation (local time) and human summaries.
import type { Schedule } from "./types";

export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const DAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const WEEKDAYS = [1, 2, 3, 4, 5];

/** "HH:MM" -> [hours, minutes], or null when malformed. */
export function parseTime(time: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return [h, min];
}

/** Normalized day set: [] and all-seven both mean "every day". */
export function normalizeDays(days: number[]): number[] {
  const set = [...new Set(days.filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b);
  return set.length === 7 ? [] : set;
}

export function runsOn(days: number[], day: number): boolean {
  return days.length === 0 || days.includes(day);
}

/** Next local time strictly after `from` that matches the schedule, or null if the time is invalid. */
export function nextRun(s: Pick<Schedule, "time" | "days">, from: Date = new Date()): Date | null {
  const t = parseTime(s.time);
  if (!t) return null;
  for (let i = 0; i <= 7; i++) {
    const c = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, t[0], t[1], 0, 0);
    if (c.getTime() > from.getTime() && runsOn(s.days, c.getDay())) return c;
  }
  return null;
}

/** Locale clock for "HH:MM", e.g. "8:30 AM" or "08:30". */
export function formatClock(time: string): string {
  const t = parseTime(time);
  if (!t) return time;
  return new Date(2000, 0, 1, t[0], t[1]).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "Every day at 2:00 AM", "Weekdays at 8:30 AM", "Mon, Wed at 9:00 AM". */
export function scheduleSummary(s: Pick<Schedule, "time" | "days">): string {
  const days = normalizeDays(s.days);
  const at = formatClock(s.time);
  if (days.length === 0) return `Every day at ${at}`;
  const key = days.join(",");
  if (key === "1,2,3,4,5") return `Weekdays at ${at}`;
  if (key === "0,6") return `Weekends at ${at}`;
  if (days.length === 1) return `${DAY_LONG[days[0]]}s at ${at}`;
  // Week starts Monday for display.
  const ordered = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return `${ordered.map((d) => DAY_SHORT[d]).join(", ")} at ${at}`;
}

/** "in 45s", "in 12m", "in 3h 12m", "in 2d 4h". */
export function untilLabel(when: Date, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((when.getTime() - now) / 1000));
  if (s < 60) return "in less than a minute";
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `in ${h}h ${m % 60}m` : `in ${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `in ${d}d ${h % 24}h` : `in ${d}d`;
}

/** "Today 2:00 AM", "Tomorrow 8:30 AM", "Tue 9:00 AM". */
export function whenLabel(when: Date, now: number = Date.now()): string {
  const today = new Date(now);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOf(when) - startOf(today)) / 86_400_000);
  const clock = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (dayDiff === 0) return `Today ${clock}`;
  if (dayDiff === 1) return `Tomorrow ${clock}`;
  return `${DAY_SHORT[when.getDay()]} ${clock}`;
}

/** Sort: enabled first by next run, then disabled by name. */
export function sortSchedules(list: Schedule[], now: Date = new Date()): Schedule[] {
  const key = (s: Schedule) => (s.enabled ? (nextRun(s, now)?.getTime() ?? Number.MAX_SAFE_INTEGER) : Infinity);
  return [...list].sort((a, b) => key(a) - key(b) || a.name.localeCompare(b.name));
}
