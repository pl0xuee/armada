import type { Agent } from "./types";

/** Window title for taskbars / WM bars: what the selected agent is doing, else plain "Kvistcode". */
export function windowTitle(agent: Agent | undefined, done: boolean): string {
  if (!agent) return "Kvistcode";
  const t = agent.title.trim() || "Agent";
  switch (agent.status) {
    case "working":
    case "starting":
      return `● Working — ${t} · Kvistcode`;
    case "needs_permission":
      return `⚠ Needs you — ${t} · Kvistcode`;
    case "error":
      return `⚠ Error — ${t} · Kvistcode`;
    case "idle":
      return done ? `✓ Done — ${t} · Kvistcode` : "Kvistcode";
    default:
      return "Kvistcode";
  }
}
