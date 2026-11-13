// Dev-only deep links for reviewing screens in the browser mock, e.g.
//   ?view=mission&tab=needs   ?agent=a-token   ?dialog=new-agent|compare|palette|review|handoff|delete
//   ?onboarding&step=2   ?section=providers   ?theme=titanium|paper|midnight…   ?look=minimal|classic
// Never active inside Tauri or in production builds.
import { applyLook, isLook } from "@/lib/look";
import { isThemeId } from "@/lib/themes";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { isTauri } from "./api";
import type { Settings } from "./types";

declare global {
  interface Window {
    /** Dev + browser mock only: store handles for automated UI checks. */
    __kvistcode?: { useApp: typeof useApp; useUi: typeof useUi };
  }
}

export function applyDevLinks() {
  if (!import.meta.env.DEV || isTauri()) return;
  window.__kvistcode = { useApp, useUi };
  const p = new URLSearchParams(location.search);
  const theme = p.get("theme") as Settings["theme"] | null;
  const app = useApp.getState();
  if (theme && app.settings && isThemeId(theme)) {
    useApp.setState({ settings: { ...app.settings, theme } });
  }
  const ui = useUi.getState();
  // Not saved: a review link must not change the look the developer left the preview in.
  const look = p.get("look");
  if (isLook(look)) {
    applyLook(look);
    useUi.setState({ look });
  }
  const dialog = p.get("dialog");
  if (!dialog) return;
  const agent = app.agents[p.get("agent") ?? ""] ?? Object.values(app.agents)[0];
  switch (dialog) {
    case "new-agent":
      ui.openNewAgent();
      break;
    case "compare":
      ui.openNewAgent({ compare: true });
      break;
    case "palette":
      ui.setPaletteOpen(true);
      break;
    case "review":
      if (agent) ui.setReviewAgent(agent.id);
      break;
    case "handoff":
      if (agent) ui.setHandoffAgent(agent);
      break;
    case "delete":
      if (agent) ui.setDeleteAgent(agent);
      break;
    default:
      break;
  }
}
