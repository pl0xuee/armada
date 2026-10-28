/** Pure helpers for request outcomes (kept out of the controller so they're testable). */

/** Progress callbacks fire per network packet; update the UI at most ~8×/s. */
export function throttledProgress(apply: (fraction: number) => void, everyMs = 125): (fraction: number) => void {
  let last = 0;
  return (f) => {
    const now = Date.now();
    if (f >= 1 || now - last >= everyMs) {
      last = now;
      apply(Math.round(f * 100) / 100);
    }
  };
}

export function commitMessage(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as { message?: unknown; hash?: unknown };
    if (typeof r.message === "string" && r.message) return r.message;
    if (typeof r.hash === "string") return `Commit ${r.hash}`;
  }
  return null;
}

/** Turn a ship result into a toast: merged, nothing to do, or committed-but-not-merged. */
export function shipOutcome(r: unknown): { tone: "ok" | "warn"; title: string; body: string | null } {
  const x = (r && typeof r === "object" ? r : {}) as { committed?: unknown; merged?: unknown; error?: unknown };
  const committed = typeof x.committed === "string" ? x.committed : null;
  const merged = typeof x.merged === "string" ? x.merged : null;
  const error = typeof x.error === "string" && x.error ? x.error : null;
  if (error) return { tone: "warn", title: committed ? "Committed, but the merge failed" : "The merge failed", body: error };
  const parts = [committed ? `Committed ${committed}.` : null, merged].filter(Boolean);
  return { tone: "ok", title: merged ? "Committed and merged" : "Committed", body: parts.join(" ") || null };
}
