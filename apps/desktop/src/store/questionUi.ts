import { create } from "zustand";
import { EMPTY_DRAFT, type QuestionDraft } from "@/lib/question";

/**
 * Per-request state of question cards that must survive the row being virtualized away:
 * what was typed/picked so far, and whether the card is on screen (keys only act on visible ones).
 */
interface QuestionUiStore {
  drafts: Record<string, QuestionDraft>;
  visible: Record<string, boolean>;
  update: (requestId: string, fn: (d: QuestionDraft) => QuestionDraft) => void;
  setVisible: (requestId: string, visible: boolean) => void;
  /** Forget a resolved request. */
  clear: (requestId: string) => void;
}

export const useQuestionUi = create<QuestionUiStore>((set) => ({
  drafts: {},
  visible: {},
  update: (id, fn) => set((s) => ({ drafts: { ...s.drafts, [id]: fn(s.drafts[id] ?? EMPTY_DRAFT) } })),
  setVisible: (id, v) => set((s) => (s.visible[id] === v ? s : { visible: { ...s.visible, [id]: v } })),
  clear: (id) =>
    set((s) => {
      if (!(id in s.drafts) && !(id in s.visible)) return s;
      const drafts = { ...s.drafts };
      const visible = { ...s.visible };
      delete drafts[id];
      delete visible[id];
      return { drafts, visible };
    }),
}));
