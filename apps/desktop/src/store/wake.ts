import { create } from "zustand";
import { api, onVaWakeStatus } from "@/lib/api";
import type { WakeStatus } from "@/lib/types";

/** What the wake phrase listener is doing; null until the first answer from the core. */
export const useWake = create<{ status: WakeStatus | null }>(() => ({ status: null }));

/** Ask the core for the status again (after a download, say). An event that lands first wins. */
export async function refreshWakeStatus(): Promise<void> {
  const seen = useWake.getState().status;
  try {
    const status = await api.vaWakeStatus();
    if (useWake.getState().status === seen) useWake.setState({ status });
  } catch {
    /* the next va-wake-status event brings it */
  }
}

/** Fetch the status once, then follow the core's `va-wake-status` events. Returns an unsubscribe function. */
export function connectWakeStatus(): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  void onVaWakeStatus((status) => useWake.setState({ status })).then((un) => {
    if (disposed) un();
    else unlisten = un;
  });
  void refreshWakeStatus();
  return () => {
    disposed = true;
    unlisten?.();
  };
}
