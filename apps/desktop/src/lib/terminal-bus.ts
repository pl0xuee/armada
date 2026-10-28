// Routes terminal_output / terminal_exit events to mounted terminal views.
// Output that arrives before a view attaches is buffered and replayed.

export interface TerminalSink {
  write: (data: string) => void;
  exit: (code: number | null) => void;
}

const sinks = new Map<string, TerminalSink>();
const pending = new Map<string, { data: string[]; exit?: number | null }>();

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

export function routeTerminalOutput(id: string, data: string) {
  const s = sinks.get(id);
  if (s) s.write(data);
  else buffer(id).data.push(data);
}

export function routeTerminalExit(id: string, code: number | null) {
  const s = sinks.get(id);
  if (s) s.exit(code);
  else buffer(id).exit = code;
}
