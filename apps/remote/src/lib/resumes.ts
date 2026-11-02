/**
 * "Resumes 6:00 PM": an agent stopped by a usage limit that Kvistcode on the desktop will continue by
 * itself. The desktop sends the time (`limitResetsAt`) only while it waits to do so, to owners and
 * viewers alike; nothing here knows the setting, so an agent without the time reads as before.
 */
import type { Agent } from "./types";

type Waiting = Pick<Agent, "rateLimited" | "limitResetsAt">;

/** "6:00 PM" today, "Thu 6:00 PM" within a week, "Nov 5, 6:00 PM" beyond (phone's local time). */
export function clockLabel(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(new Date(now))) / 86_400_000);
  if (days > 0 && days < 7) return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/** The compact line for a waiting agent, or null when the desktop is not going to resume it. */
export function resumesLabel(agent: Waiting, now: number = Date.now()): string | null {
  if (agent.rateLimited !== true || typeof agent.limitResetsAt !== "number") return null;
  return agent.limitResetsAt <= now ? "Resuming…" : `Resumes ${clockLabel(agent.limitResetsAt, now)}`;
}
