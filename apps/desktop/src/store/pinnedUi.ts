import { create } from "zustand";
import { onAgentRemoved } from "./app";

/**
 * UI state of the pinned dock that outlives it unmounting: whether each agent's pinned plan was
 * expanded or collapsed by the user (unset: the default for its length), and which agents have a plan
 * pinned right now (the plan card in the timeline stays quiet meanwhile).
 */
interface PinnedUiStore {
  planOpen: Record<string, boolean>;
  planPinned: Record<string, boolean>;
  setPlanOpen: (agentId: string, open: boolean) => void;
  setPlanPinned: (agentId: string, pinned: boolean) => void;
}

export const usePinnedUi = create<PinnedUiStore>((set) => ({
  planOpen: {},
  planPinned: {},
  setPlanOpen: (id, open) => set((s) => (s.planOpen[id] === open ? s : { planOpen: { ...s.planOpen, [id]: open } })),
  setPlanPinned: (id, pinned) =>
    set((s) => {
      if (Boolean(s.planPinned[id]) === pinned) return s;
      const planPinned = { ...s.planPinned };
      if (pinned) planPinned[id] = true;
      else delete planPinned[id];
      return { planPinned };
    }),
}));

// An agent deleted for real takes its plan state with it (a pending, undoable delete keeps it).
onAgentRemoved((id) =>
  usePinnedUi.setState((s) => {
    if (!(id in s.planOpen) && !(id in s.planPinned)) return s;
    const { [id]: _open, ...planOpen } = s.planOpen;
    const { [id]: _pinned, ...planPinned } = s.planPinned;
    return { planOpen, planPinned };
  }),
);
