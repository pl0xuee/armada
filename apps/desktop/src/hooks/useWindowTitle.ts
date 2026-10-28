import { useEffect } from "react";
import { api } from "@/lib/api";
import { windowTitle } from "@/lib/windowTitle";
import { isDone, useCompletion } from "@/store/completion";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";

/** Mirrors the selected agent's state into the OS window title (debounced). */
export function useWindowTitle(enabled: boolean) {
  const selected = useUi((st) => (st.view === "agents" ? st.selectedAgentId : null));
  const agent = useApp((st) => (selected ? st.agents[selected] : undefined));
  const marked = useCompletion((st) => !!(selected && st.done[selected]));
  const text = windowTitle(agent, agent ? isDone(agent, marked) : false);
  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(() => api.setWindowTitle(text).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [text, enabled]);
}
