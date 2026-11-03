import { create } from "zustand";
import { onAgentRemoved, useApp } from "./app";

/**
 * Per-request UI state for approval cards that must survive the row being virtualized away:
 * whether the card is on screen (keyboard approvals only act on visible cards), whether
 * "always allow" is armed (Shift+A twice), and the "deny with reason" draft.
 */
interface PermissionUiStore {
  visible: Record<string, boolean>;
  /** The request's actions are docked above the composer (ApprovalDock): always reachable, and the timeline card needn't repeat them. */
  docked: Record<string, boolean>;
  armed: Record<string, boolean>;
  reasonDraft: Record<string, string>;
  setVisible: (requestId: string, visible: boolean) => void;
  setDocked: (requestId: string, docked: boolean) => void;
  setArmed: (requestId: string, armed: boolean) => void;
  setReasonDraft: (requestId: string, text: string) => void;
  /** Forget a resolved request. */
  clear: (requestId: string) => void;
}

function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  const next = { ...rec };
  delete next[key];
  return next;
}

export const usePermissionUi = create<PermissionUiStore>((set) => ({
  visible: {},
  docked: {},
  armed: {},
  reasonDraft: {},
  setVisible: (id, v) => set((s) => (s.visible[id] === v ? s : { visible: { ...s.visible, [id]: v } })),
  setDocked: (id, v) =>
    set((s) => (Boolean(s.docked[id]) === v ? s : { docked: v ? { ...s.docked, [id]: true } : without(s.docked, id) })),
  setArmed: (id, v) =>
    set((s) => (Boolean(s.armed[id]) === v ? s : { armed: v ? { ...s.armed, [id]: true } : without(s.armed, id) })),
  setReasonDraft: (id, text) =>
    set((s) => ({ reasonDraft: text ? { ...s.reasonDraft, [id]: text } : without(s.reasonDraft, id) })),
  clear: (id) =>
    set((s) => ({
      visible: without(s.visible, id),
      docked: without(s.docked, id),
      armed: without(s.armed, id),
      reasonDraft: without(s.reasonDraft, id),
    })),
}));

// An agent deleted for real leaves no approval card behind: forget what was kept for its requests.
onAgentRemoved((agentId) => {
  for (const it of useApp.getState().items[agentId] ?? []) {
    if (it.kind === "permission") usePermissionUi.getState().clear(it.requestId);
  }
});
