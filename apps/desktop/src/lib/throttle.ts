/**
 * Emits at most once per `ms`: the first value goes out immediately, later ones are held and only the
 * latest is delivered when the window ends. `flush` delivers right away; `cancel` drops what is held.
 */
export function createThrottle<T>(ms: number, emit: (value: T) => void) {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let held: { value: T } | undefined;

  const send = (value: T) => {
    clearTimeout(timer);
    timer = undefined;
    held = undefined;
    last = Date.now();
    emit(value);
  };

  return {
    push(value: T) {
      const wait = last + ms - Date.now();
      if (wait <= 0) return send(value);
      held = { value };
      timer ??= setTimeout(() => held && send(held.value), wait);
    },
    flush: send,
    cancel() {
      clearTimeout(timer);
      timer = undefined;
      held = undefined;
    },
  };
}

/**
 * Coalesces keyed writes: `set` can be called as often as you like, `write` runs once with the latest
 * value per key after `ms` without new calls. `flush` writes immediately (e.g. on pagehide).
 */
export function createCoalescedWriter<K, V>(ms: number, write: (entries: ReadonlyMap<K, V>) => void) {
  const pending = new Map<K, V>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (pending.size === 0) return;
    const entries = new Map(pending);
    pending.clear();
    write(entries);
  };

  return {
    set(key: K, value: V) {
      pending.set(key, value);
      clearTimeout(timer);
      timer = setTimeout(flush, ms);
    },
    flush,
  };
}
