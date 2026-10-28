import { api } from "@/lib/api";
import type { RemoteStatus } from "@/lib/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * After a remote-settings change the server (re)starts asynchronously: poll briefly until it
 * settles, reporting each status so the UI can show "Starting…" instead of a stale or error state.
 */
export async function pollRemoteStatus(
  onStatus: (s: RemoteStatus, settled: boolean) => void,
  { tries = 15, intervalMs = 400 }: { tries?: number; intervalMs?: number } = {},
): Promise<RemoteStatus> {
  let last = await api.remoteStatus();
  for (let i = 0; i < tries && !(last.running || !last.enabled); i++) {
    // An error right after a change can be transient (old server still releasing the port): keep polling.
    onStatus(last, false);
    await sleep(intervalMs);
    last = await api.remoteStatus();
  }
  onStatus(last, true);
  return last;
}
