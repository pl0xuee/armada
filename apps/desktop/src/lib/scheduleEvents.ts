// Schedules aren't kept in the global store (only the Schedules view needs them);
// schedule_updated / schedule_removed events are fanned out to whoever is listening.
import type { Schedule } from "./types";

export type ScheduleEvent = { type: "updated"; schedule: Schedule } | { type: "removed"; scheduleId: string };

const listeners = new Set<(e: ScheduleEvent) => void>();

export function onScheduleEvent(cb: (e: ScheduleEvent) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function publishScheduleEvent(e: ScheduleEvent) {
  for (const l of listeners) l(e);
}
