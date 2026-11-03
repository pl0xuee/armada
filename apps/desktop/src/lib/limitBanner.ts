// The rate-limit banner's words: one plain headline and at most one short line under it.
import { clockLabel, MAX_RESUME_TRIES, untilLabel, waitingToResume } from "./limitResume";
import { resetClause } from "./pinned";
import type { Agent } from "./types";

type Limited = Pick<Agent, "rateLimited" | "status" | "limitResume" | "limitResetsAt">;

/** "3:40 PM" -> "3:40 pm"; the day word of "Thu 3:40 PM" keeps its capital. */
export function softClock(label: string): string {
  return label.replace(/\s*([AP])M\b/, (_m, c: string) => ` ${c.toLowerCase()}m`);
}

export interface LimitCopy {
  /** "Rate limit reached. Resumes at 3:40 pm" */
  headline: string;
  /** One short sentence about what happens next; null when there is nothing to add. */
  sub: string | null;
}

/**
 * What the banner says. `notice` is the provider's own message, used for a reset time only when the
 * agent carries none; `resumeOn` is the automatic-resume setting.
 */
export function limitCopy(
  agent: Limited,
  resumeOn: boolean,
  notice: string | null,
  now: number = Date.now(),
): LimitCopy {
  const at = agent.limitResetsAt ?? null;
  const waiting = waitingToResume(agent, resumeOn);
  const clock = at != null && at > now ? softClock(clockLabel(at, now)) : null;
  // The provider's wording ("Resets at 6:00 PM"), minus its leading verb.
  const said = clock ? null : (resetClause(notice)?.replace(/^Resets\s+/i, "") ?? null);

  if (waiting) {
    const when = clock ? `Resumes at ${clock}` : at != null ? "Resuming now" : "Resumes when it lifts";
    const sub =
      clock && at != null ? `Kvistcode continues by itself, ${untilLabel(at, now)}.` : "Kvistcode continues by itself.";
    return { headline: `Rate limit reached. ${when}`, sub };
  }
  const headline = clock
    ? `Rate limit reached. Resets at ${clock}`
    : said
      ? `Rate limit reached. Resets ${said}`
      : "Rate limit reached. Try again later";
  let sub: string | null = null;
  if (resumeOn && agent.rateLimited) {
    if (agent.limitResume?.state === "cancelled") sub = "Automatic resume is off for this agent.";
    else if (agent.limitResume?.state === "gave_up") {
      sub = `Kvistcode tried ${MAX_RESUME_TRIES} times and the limit is still on.`;
    }
  }
  return { headline, sub };
}
