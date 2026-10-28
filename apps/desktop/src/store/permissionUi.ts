import { create } from "zustand";

/**
 * Per-request UI state for approval cards that must survive the row being virtualized away:
 * whether the card is on screen (keyboard approvals only act on visible cards), whether
 * "always allow" is armed (Shift+A twice), and the "deny with reason" draft.
 */
interface PermissionUiStore {
  visible: Record<string, boolean>;
  armed: Record<string, boolean>;
  reasonDraft: Record<string, string>;
  setVisible: (requestId: string, visible: boolean) => void;
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
  armed: {},
  reasonDraft: {},
  setVisible: (id, v) => set((s) => (s.visible[id] === v ? s : { visible: { ...s.visible, [id]: v } })),
  setArmed: (id, v) =>
    set((s) => (Boolean(s.armed[id]) === v ? s : { armed: v ? { ...s.armed, [id]: true } : without(s.armed, id) })),
  setReasonDraft: (id, text) =>
    set((s) => ({ reasonDraft: text ? { ...s.reasonDraft, [id]: text } : without(s.reasonDraft, id) })),
  clear: (id) =>
    set((s) => ({
      visible: without(s.visible, id),
      armed: without(s.armed, id),
      reasonDraft: without(s.reasonDraft, id),
    })),
}));
