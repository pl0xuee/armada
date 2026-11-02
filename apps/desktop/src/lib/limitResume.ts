// Agents waiting for a rate limit to lift, as the interface words them. Kvistcode resumes them by
// itself (core `limit_resume`); this is only how that reads: "Resumes 6:00 PM", "in 12 min".
import { useEffect, useState } from "react";
import type { Agent } from "./types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The most tries per limit; mirrors the core's `MAX_ATTEMPTS`. */
export const MAX_RESUME_TRIES = 3;

type Waiter = Pick<Agent, "rateLimited" | "status" | "limitResume" | "limitResetsAt">;

/** Is Kvistcode going to resume this agent by itself? (Needs the setting on.) */
export function waitingToResume(agent: Waiter | null | undefined, enabled: boolean): boolean {
  return (
    enabled &&
    !!agent &&
    agent.rateLimited === true &&
    agent.status === "error" &&
    agent.limitResume?.state === "waiting"
  );
}

/** "6:00 PM"; "Thu 6:00 PM" within a week; "Nov 5, 6:00 PM" beyond. Local time. */
export function clockLabel(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const today = new Date(now);
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return time;
  const days = Math.round((startOfDay(d) - startOfDay(today)) / DAY);
  if (days > 0 && days < 7) return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "in 12 min", "in 1 h 5 min", "in 2 d 3 h", "in under a minute"; minute granularity. */
export function untilLabel(at: number, now: number = Date.now()): string {
  const ms = at - now;
  if (ms < MINUTE) return "in under a minute";
  const mins = Math.ceil(ms / MINUTE);
  if (mins < 60) return `in ${mins} min`;
  if (ms < DAY) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m === 0 ? `in ${h} h` : `in ${h} h ${m} min`;
  }
  const d = Math.floor(ms / DAY);
  const h = Math.round((ms - d * DAY) / HOUR);
  return h === 0 ? `in ${d} d` : `in ${d} d ${h} h`;
}

/** The backend's "Resumed 3 agents after your rate limit reset" alert (core `limit_resume::is_resumed_body`). */
export function isResumedBody(body: string): boolean {
  return body.startsWith("Resumed ") && body.endsWith(" after your rate limit reset");
}

/** The short row/chip text: "Resumes 6:00 PM". Null when nothing is waiting. */
export function resumesShort(agent: Waiter | null | undefined, enabled: boolean, now: number = Date.now()): string | null {
  if (!waitingToResume(agent, enabled)) return null;
  const at = agent!.limitResetsAt;
  if (at == null) return "Resumes when it lifts";
  if (at <= now) return "Resuming…";
  return `Resumes ${clockLabel(at, now)}`;
}

export interface ResumeLine {
  /** "Resuming automatically at 6:00 PM" */
  text: string;
  /** "in 12 min" (null when there is no time or it has come) */
  countdown: string | null;
  /** Which try this is, after the first failed: "try 2 of 3". */
  tries: string | null;
}

/** The banner's line for an agent that will be resumed; null when nothing is waiting. */
export function resumeLine(agent: Waiter | null | undefined, enabled: boolean, now: number = Date.now()): ResumeLine | null {
  if (!waitingToResume(agent, enabled)) return null;
  const at = agent!.limitResetsAt;
  const attempts = agent!.limitResume?.attempts ?? 0;
  const verb = attempts > 0 ? "Trying again automatically" : "Resuming automatically";
  const tries = attempts > 0 ? `try ${attempts + 1} of ${MAX_RESUME_TRIES}` : null;
  if (at == null) {
    return { text: `${attempts > 0 ? "Will try again" : "Will resume automatically"} when the limit lifts`, countdown: null, tries };
  }
  if (at <= now) return { text: `${verb} now`, countdown: null, tries };
  return { text: `${verb} at ${clockLabel(at, now)}`, countdown: untilLabel(at, now), tries };
}

/** What replaces the line when Kvistcode will not (or no longer) resume this agent; null if it is not a limit case. */
export function notResumingNote(agent: Waiter | null | undefined, enabled: boolean): string | null {
  if (!agent?.rateLimited || !enabled) return null;
  switch (agent.limitResume?.state) {
    case "cancelled":
      return "Automatic resume is off for this agent.";
    case "gave_up":
      return `Kvistcode tried ${MAX_RESUME_TRIES} times and the limit is still on.`;
    default:
      return null;
  }
}

/**
 * Re-renders the caller when the minute changes, only while `active` and the window is visible
 * (a countdown nobody can see costs nothing).
 */
export function useMinuteNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      setNow((prev) => {
        const next = Date.now();
        return Math.floor(next / MINUTE) === Math.floor(prev / MINUTE) ? prev : next;
      });
    };
    const id = setInterval(tick, 15_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [active]);
  return now;
}
