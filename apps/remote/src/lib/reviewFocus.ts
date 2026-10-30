/**
 * "Open this file's diff in Review": a tapped file in a turn summary hands its path to the Review
 * screen (as the desktop's `setReviewAgent(agentId, file)` does). A one-shot hand-off instead of a
 * route parameter, so the route table and URLs stay as they are.
 */
let pending: { agentId: string; path: string } | null = null;

export function setReviewFocus(agentId: string, path: string) {
  pending = { agentId, path };
}

/** The file Review should open for this agent, once. */
export function takeReviewFocus(agentId: string): string | null {
  const p = pending;
  pending = null;
  return p && p.agentId === agentId ? p.path : null;
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");

/**
 * Index of the patch file that `target` names. A summary lists paths as the agent reported them
 * (often absolute), the patch uses repo-relative ones: equal, or one ends with the other at a "/".
 */
export function findFileIndex(paths: readonly string[], target: string): number {
  const t = norm(target);
  const exact = paths.findIndex((p) => norm(p) === t);
  if (exact >= 0) return exact;
  return paths.findIndex((p) => {
    const n = norm(p);
    return n.length > 0 && (t.endsWith(`/${n}`) || n.endsWith(`/${t}`));
  });
}
