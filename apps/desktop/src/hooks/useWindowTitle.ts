import { useEffect } from "react";
import { useTriageCount } from "@/components/triage/useTriage";
import { api } from "@/lib/api";
import { backgroundActive, backgroundShort } from "@/lib/background";
import { windowTitle } from "@/lib/windowTitle";
import { useBackground } from "@/store/background";
import { isDone, useCompletion } from "@/store/completion";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";

/**
 * Mirrors the selected agent's state into the OS window title (debounced), led by the number of agents
 * that need you: the same count as the rail badge and the Needs you tab, so it shows in a taskbar too.
 * That count also goes to the tray (tooltip and "Needs you (n)" menu item).
 */
export function useWindowTitle(enabled: boolean) {
  const selected = useUi((st) => (st.view === "agents" ? st.selectedAgentId : null));
  const agent = useApp((st) => (selected ? st.agents[selected] : undefined));
  const marked = useCompletion((st) => !!(selected && st.done[selected]));
  const needs = useTriageCount();
  const bg = useBackground(selected ?? "");
  const base = windowTitle(
    agent,
    agent ? isDone(agent, marked) : false,
    backgroundActive(bg) ? backgroundShort(bg) : null,
  );
  const text = needs > 0 ? `(${needs}) ${base}` : base;
  useEffect(() => {
    document.title = text;
    if (!enabled) return;
    const t = setTimeout(() => api.setWindowTitle(text).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [text, enabled]);

  // The tray shows the same count (the backend doesn't work it out itself, so they can't disagree).
  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(() => api.setNeedsYouCount(needs).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [needs, enabled]);
}
