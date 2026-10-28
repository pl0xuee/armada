import { useEffect } from "react";
import { agentsToPoll, PR_POLL_MS } from "@/lib/pr";
import { useApp } from "@/store/app";
import { refreshPr } from "@/store/pr";
import { useUi } from "@/store/ui";

/**
 * Keeps PR/CI status fresh: every minute while the window is focused, and right away when
 * focus returns or another agent is opened. Only the selected agent and branch agents that
 * are working or were recently active are polled; the backend caches and backs off on errors.
 */
export function usePrPolling() {
  const focused = useUi((s) => s.windowFocused);
  const selected = useUi((s) => (s.view === "agents" ? s.selectedAgentId : null));

  useEffect(() => {
    if (!focused) return;
    let stopped = false;
    const run = async () => {
      const { agents } = useApp.getState();
      const sel = useUi.getState().selectedAgentId;
      const ids = agentsToPoll(Object.values(agents), sel, Date.now());
      // One at a time: gentle on gh and the rate limit.
      for (const id of ids) {
        if (stopped) return;
        if (agents[id]?.branch) await refreshPr(id);
      }
    };
    void run();
    const t = setInterval(() => void run(), PR_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [focused, selected]);
}
