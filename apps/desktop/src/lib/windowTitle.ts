import type { Agent } from "./types";

/** Window title for taskbars / WM bars: what the selected agent is doing, else plain "Armada". */
export function windowTitle(agent: Agent | undefined, done: boolean): string {
  if (!agent) return "Armada";
  const t = agent.title.trim() || "Agent";
  switch (agent.status) {
    case "working":
    case "starting":
      return `● Working — ${t} · Armada`;
    case "needs_permission":
      return `⚠ Needs approval — ${t} · Armada`;
    case "error":
      return `⚠ Error — ${t} · Armada`;
    case "idle":
      return done ? `✓ Done — ${t} · Armada` : "Armada";
    default:
      return "Armada";
  }
}
