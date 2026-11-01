/**
 * A store selector that only looks at `agents` and recomputes when that object is replaced. The store
 * replaces `items` on every streamed frame, which runs every mounted selector; those that don't read
 * `items` would otherwise redo an O(agents) scan per frame, per subscriber.
 */
export function selectFromAgents<A, T>(compute: (agents: A) => T): (state: { agents: A }) => T {
  let last: A | undefined;
  let value: T;
  let have = false;
  return (state) => {
    if (!have || state.agents !== last) {
      last = state.agents;
      value = compute(state.agents);
      have = true;
    }
    return value;
  };
}
