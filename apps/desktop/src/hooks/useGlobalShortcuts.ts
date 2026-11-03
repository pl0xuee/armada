import { useEffect } from "react";
import { orderedAgents } from "@/lib/agents";
import { onVaHotkey } from "@/lib/api";
import { LIST_DOCK_QUERY } from "@/lib/layout";
import { selectNextTriage, triageQueueNow } from "@/components/triage/useTriage";
import { toggleAgentList } from "./useAgentListLayout";
import { isEditableTarget, isMac } from "@/lib/utils";
import { openShortcutHelp, toggleShortcutHelp } from "@/components/shell/ShortcutHelp";
import { stepInterfaceScale } from "@/lib/zoom";
import { useApp } from "@/store/app";
import { goBack, goForward } from "@/store/navHistory";
import { togglePreview } from "@/store/preview";
import { useUi } from "@/store/ui";
import { toggleVoiceAssistant } from "@/store/voiceAssistant";

/** App-wide keyboard shortcuts. Mod = ⌘ on macOS, Ctrl elsewhere. */
export function useGlobalShortcuts(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      // ⌘ on macOS, Ctrl elsewhere (Ctrl+K on a Mac is a text-editing shortcut).
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      // "?" (not while typing) opens the shortcut cheat sheet.
      if (!mod && e.key === "?" && !e.altKey && !e.repeat && !isEditableTarget(e.target) && !dialogOpen()) {
        e.preventDefault();
        openShortcutHelp();
        return;
      }
      const nav = navKey(e);
      if (nav && !e.repeat && !dialogOpen() && !inTerminal(e.target)) {
        e.preventDefault();
        if (nav === "back") goBack();
        else goForward();
        return;
      }
      if (!mod || e.altKey) return;
      const ui = useUi.getState();
      const key = e.key.toLowerCase();

      if (e.key === "/" && !e.shiftKey) {
        e.preventDefault();
        toggleShortcutHelp();
        return;
      }

      // Interface zoom works anywhere, even over a dialog.
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        stepInterfaceScale(1);
        return;
      }
      if (e.key === "-" && !e.shiftKey) {
        e.preventDefault();
        stepInterfaceScale(-1);
        return;
      }
      if (e.key === "0" && !e.shiftKey) {
        e.preventDefault();
        stepInterfaceScale(0);
        return;
      }

      if (key === "k" && !e.shiftKey) {
        // The palette toggles itself; any other open dialog blocks it.
        if (!ui.paletteOpen && dialogOpen()) return;
        e.preventDefault();
        ui.setPaletteOpen(!ui.paletteOpen);
        return;
      }
      if (key === "f" && e.shiftKey) {
        // Search every conversation (the palette's "?" mode); pressed again, it closes.
        if (!ui.paletteOpen && dialogOpen()) return;
        e.preventDefault();
        if (ui.paletteOpen) ui.setPaletteOpen(false);
        else ui.openSearch();
        return;
      }
      // Never navigate out from under an open dialog, sheet or menu.
      if (dialogOpen()) return;
      if (key === "n" && !e.shiftKey) {
        e.preventDefault();
        ui.setPaletteOpen(false);
        ui.openNewAgent();
        return;
      }
      if (key === "b" && !e.shiftKey) {
        e.preventDefault();
        if (ui.view !== "agents") {
          ui.setView("agents");
          const layout = window.matchMedia(LIST_DOCK_QUERY).matches ? "wide" : "narrow";
          ui.setAgentList(layout, true);
        } else {
          toggleAgentList();
        }
        return;
      }
      if (e.key === "`" && !e.shiftKey) {
        // Workspace panel (terminals, scripts) of the open agent.
        if (ui.view !== "agents" || !ui.selectedAgentId) return;
        e.preventDefault();
        ui.setWorkspaceOpen(!ui.workspaceOpen);
        return;
      }
      if (key === "p" && e.shiftKey) {
        // Preview pane (right of the conversation) of the open agent.
        if (ui.view !== "agents" || !ui.selectedAgentId) return;
        e.preventDefault();
        togglePreview(ui.selectedAgentId);
        return;
      }
      if (key === "j" && !e.shiftKey) {
        e.preventDefault();
        // Opens Mission Control's "Needs you" tab; pressed again there, moves to the next waiting agent.
        if (ui.view === "mission" && ui.missionTab === "needs") selectNextTriage(triageQueueNow());
        else ui.openMission("needs");
        return;
      }
      if (key === "i" && !e.shiftKey) {
        // The old Inbox's key: pending approvals are the first thing in "Needs you".
        e.preventDefault();
        ui.openMission("needs");
        return;
      }
      if (key === "a" && e.shiftKey) {
        e.preventDefault();
        toggleVoiceAssistant();
        return;
      }
      if (key === "m" && e.shiftKey) {
        e.preventDefault();
        ui.openMission("all");
        return;
      }
      if (e.key === "," && !e.shiftKey) {
        e.preventDefault();
        ui.openSettings();
        return;
      }
      if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
        const list = orderedAgents(Object.values(useApp.getState().agents));
        const target = list[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          ui.openAgent(target.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);

  // The mouse's back and forward side buttons.
  useEffect(() => {
    if (!enabled) return;
    const onUp = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (dialogOpen()) return;
      if (e.button === 3) goBack();
      else goForward();
    };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, [enabled]);

  // The system-wide voice assistant hotkey (works while the window is in the background):
  // the shell sends an event, and it does what the in-app shortcut does.
  useEffect(() => {
    if (!enabled) return;
    let off: (() => void) | null = null;
    let gone = false;
    void onVaHotkey(toggleVoiceAssistant).then((un) => {
      if (gone) un();
      else off = un;
    });
    return () => {
      gone = true;
      off?.();
    };
  }, [enabled]);
}

/** Back / Forward: ⌘[ and ⌘] on macOS, Alt+← and Alt+→ elsewhere (as in browsers). */
export function navKey(e: KeyboardEvent): "back" | "forward" | null {
  if (e.shiftKey) return null;
  if (isMac) {
    if (!e.metaKey || e.ctrlKey || e.altKey) return null;
    return e.key === "[" ? "back" : e.key === "]" ? "forward" : null;
  }
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  return e.key === "ArrowLeft" ? "back" : e.key === "ArrowRight" ? "forward" : null;
}

/** A shell uses Alt+arrows itself (word moves). */
function inTerminal(t: EventTarget | null): boolean {
  return t instanceof Element && t.closest(".xterm") !== null;
}

function dialogOpen(): boolean {
  return !!document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]',
  );
}
