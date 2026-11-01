import type { Agent } from "./types";

/**
 * Window title for taskbars / WM bars: what the selected agent is doing, else plain "Kvistcode".
 * `background`: what is still running after its turn ended ("Workflow 3 of 5 running"), if anything.
 */
export function windowTitle(agent: Agent | undefined, done: boolean, background?: string | null): string {
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
      if (background) return `● ${background} — ${t} · Kvistcode`;
      return done ? `✓ Done — ${t} · Kvistcode` : "Kvistcode";
    default:
      return "Kvistcode";
  }
}
