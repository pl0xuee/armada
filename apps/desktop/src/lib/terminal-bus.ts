// Routes terminal_output / terminal_exit events to mounted terminal views.
// Output that arrives before a view attaches is buffered and replayed.

export interface TerminalSink {
  write: (data: string) => void;
  exit: (code: number | null) => void;
}

const sinks = new Map<string, TerminalSink>();
const pending = new Map<string, { data: string[]; size?: number; exit?: number | null }>();

export function attachTerminal(id: string, sink: TerminalSink): () => void {
  sinks.set(id, sink);
  const buf = pending.get(id);
  if (buf) {
    pending.delete(id);
    for (const d of buf.data) sink.write(d);
    if (buf.exit !== undefined) sink.exit(buf.exit);
  }
  return () => {
    if (sinks.get(id) === sink) sinks.delete(id);
  };
}

function buffer(id: string) {
  let b = pending.get(id);
  if (!b) {
    b = { data: [] };
    pending.set(id, b);
    // Don't hold on to output for terminals nobody opens.
    setTimeout(() => pending.delete(id), 5 * 60_000);
  }
  return b;
}

/** Cap on output buffered for a terminal nobody has opened yet (oldest chunks are dropped). */
const MAX_PENDING_CHARS = 2_000_000;

export function routeTerminalOutput(id: string, data: string) {
  const s = sinks.get(id);
  if (s) {
    s.write(data);
    return;
  }
  const b = buffer(id);
  b.data.push(data);
  b.size = (b.size ?? 0) + data.length;
  while (b.size > MAX_PENDING_CHARS && b.data.length > 1) b.size -= b.data.shift()?.length ?? 0;
}

export function routeTerminalExit(id: string, code: number | null) {
  const s = sinks.get(id);
  if (s) s.exit(code);
  else buffer(id).exit = code;
}
