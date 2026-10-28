import { useEffect, useRef, useState } from "react";
import { identityFor } from "@/lib/identity";
import type { Agent } from "@/lib/types";
import { useApp } from "@/store/app";

/**
 * App-wide polite live region: announces new approval requests and agents that hit an
 * error, derived from transitions in the agents map (works on every view).
 */
export function Announcer() {
  const [message, setMessage] = useState("");
  const prev = useRef<Record<string, Agent> | null>(null);

  useEffect(
    () =>
      useApp.subscribe((s) => {
        const before = prev.current;
        prev.current = s.agents;
        if (!before || before === s.agents) return;
        const custom = s.settings?.customAgents;
        const lines: string[] = [];
        for (const a of Object.values(s.agents)) {
          const old = before[a.id];
          if (!old || a.archived) continue;
          const who = `${a.title} (${identityFor(a.provider, a.customAgentId, custom).short})`;
          if (a.pendingPermissions > old.pendingPermissions) lines.push(`${who} needs your approval.`);
          else if (a.status === "error" && old.status !== "error")
            lines.push(a.rateLimited ? `${who} hit its usage limit.` : `${who} stopped with an error.`);
        }
        if (lines.length) setMessage(lines.join(" "));
      }),
    [],
  );

  // Clear after a moment so a repeat of the same text is announced again.
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(""), 4000);
    return () => clearTimeout(t);
  }, [message]);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}
