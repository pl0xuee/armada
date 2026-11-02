// The "workflow finished" alert, once per run and saying what finished. No React here, so all of it
// is unit-tested.

/** How long a run must stay finished before it is announced (a quiet spell mid-run is not the end). */
export const ALERT_SETTLE_MS = 60_000;

const NOTIFIED_KEY = "kvistcode.bgfinished.v1";
const NOTIFIED_MAX = 300;

/** The runs already announced, kept across restarts so a reload never announces one twice. */
export class NotifiedRuns {
  private keys: string[];
  constructor(private storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage()) {
    this.keys = [];
    try {
      const raw = JSON.parse(storage?.getItem(NOTIFIED_KEY) ?? "[]");
      if (Array.isArray(raw)) this.keys = raw.filter((k): k is string => typeof k === "string").slice(-NOTIFIED_MAX);
    } catch {
      /* unreadable: start empty */
    }
  }
  has(key: string): boolean {
    return this.keys.includes(key);
  }
  add(key: string): void {
    if (this.has(key)) return;
    this.keys = [...this.keys, key].slice(-NOTIFIED_MAX);
    try {
      this.storage?.setItem(NOTIFIED_KEY, JSON.stringify(this.keys));
    } catch {
      /* storage full or blocked: in-memory is enough for this session */
    }
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

interface AgentLike {
  status: "working" | "finished" | "failed" | "unknown";
}

/** "Workflow finished: “Five parallel agents…”. All 5 agents completed." (one line, no secrets). */
export function workflowFinishedDetail(description: string | null | undefined, agents: AgentLike[]): string {
  const clean = (description ?? "").replace(/\s+/g, " ").trim();
  const what = clean ? `“${clean.length > 90 ? `${clean.slice(0, 89)}…` : clean}”` : "its workflow";
  const n = agents.length;
  if (n === 0) return `Workflow finished: ${what}.`;
  const failed = agents.filter((a) => a.status === "failed").length;
  const done = agents.filter((a) => a.status === "finished").length;
  const noun = n === 1 ? "agent" : "agents";
  if (failed > 0) {
    return `Workflow finished with problems: ${what}. ${done} of ${n} ${noun} completed, ${failed} failed.`;
  }
  if (done === n) return `Workflow finished: ${what}. ${n === 1 ? "The agent" : `All ${n} agents`} completed.`;
  return `Workflow finished: ${what}. ${done} of ${n} ${noun} reported completing.`;
}
