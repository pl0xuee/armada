// Whether the "what you can do" tour is open. When it opens by itself is decided in lib/tour.ts.
import { create } from "zustand";

export const useTour = create<{ open: boolean }>(() => ({ open: false }));

export function openTour() {
  useTour.setState({ open: true });
}

export function closeTour() {
  useTour.setState({ open: false });
}
