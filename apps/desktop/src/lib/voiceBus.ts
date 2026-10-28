// In-page stand-in for the Tauri voice events, used by the browser mock backend.

type Listener = (payload: never) => void;
const listeners = new Map<string, Set<Listener>>();

export function onVoiceBus<T>(name: string, cb: (payload: T) => void): () => void {
  const set = listeners.get(name) ?? new Set<Listener>();
  listeners.set(name, set);
  set.add(cb as Listener);
  return () => set.delete(cb as Listener);
}

export function emitVoiceBus(name: string, payload?: unknown): void {
  for (const cb of listeners.get(name) ?? []) (cb as (p: unknown) => void)(payload);
}
