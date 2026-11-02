/**
 * Keeps `state.background` current: which agents whose own turn has ended still have a Workflow
 * running (the desktop app reads the runs; the phone asks `GET /api/background`).
 *
 * Nothing polls while nothing runs. A read happens when the list of idle agents gains one (the
 * first load, a turn that just ended), then every POLL_MS while some workflow is known to run and
 * the page is visible, and once more when the page comes back to the foreground. When the last
 * workflow of an agent that is still idle ends, a quiet toast says so unless the agent is open.
 */
import { api, ApiError } from "./api";
import { backgroundActive, parseBackground, type BackgroundWork } from "./background";
import { activeBackend, handleAuthError, pushToast } from "./controller";
import { getRoute } from "./router";
import { getState, setState, subscribe } from "./store";

export const BACKGROUND_POLL_MS = 5_000;

const isIdle = (a: { status: string; archived: boolean }) => a.status === "idle" && !a.archived;

/** The toast for a workflow that ended while its agent sat idle and unwatched. */
export function finishedAgents(
  before: Record<string, BackgroundWork>,
  after: Record<string, BackgroundWork>,
  agents: Record<string, { status: string; archived: boolean }>,
): string[] {
  return Object.keys(before).filter((id) => backgroundActive(before[id]) && !backgroundActive(after[id]) && agents[id] && isIdle(agents[id]));
}

export function installBackgroundTracker(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight = false;
  let again = false;
  /** The backend whose server doesn't know the endpoint (older desktop app). */
  let unsupported: unknown = null;
  let idleIds = new Set<string>();
  let seenAgents: unknown = null;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const schedule = () => {
    clear();
    if (!Object.keys(getState().background).length) return;
    timer = setTimeout(() => void read(), BACKGROUND_POLL_MS);
  };

  async function read() {
    clear();
    const b = activeBackend();
    if (!b || unsupported === b || getState().phase !== "ready") return;
    if (document.visibilityState !== "visible" || !navigator.onLine) {
      schedule();
      return;
    }
    if (inflight) {
      again = true;
      return;
    }
    inflight = true;
    try {
      const raw = await api.background(b);
      if (activeBackend() !== b) return;
      const before = getState().background;
      const after = parseBackground(raw);
      const s = getState();
      // An agent that is no longer idle (a new turn) has nothing "behind" its turn any more.
      for (const id of Object.keys(after)) if (!s.agents[id] || !isIdle(s.agents[id])) delete after[id];
      const same =
        Object.keys(before).length === Object.keys(after).length &&
        Object.entries(after).every(([id, v]) => {
          const o = before[id];
          return o && o.workflows === v.workflows && o.working === v.working && o.total === v.total;
        });
      if (!same) setState({ background: after });
      const route = getRoute();
      for (const id of finishedAgents(before, after, s.agents)) {
        if (route.name === "agent" && route.agentId === id) continue; // the header already changed in front of them
        pushToast({ tone: "ok", title: s.agents[id].title, body: "Everything finished", agentId: id, reason: "done", duration: 6_000 });
      }
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) unsupported = b;
      else handleAuthError(e); // anything else: keep what we knew, try again on the next trigger
    } finally {
      inflight = false;
      if (again) {
        again = false;
        void read();
      } else schedule();
    }
  }

  const off = subscribe(() => {
    const s = getState();
    if (s.agents === seenAgents) return; // streamed text and the like: nothing about the agents changed
    seenAgents = s.agents;
    if (s.stateStatus !== "ready") {
      if (idleIds.size) idleIds = new Set();
      return;
    }
    const idle = new Set<string>();
    let gained = false;
    for (const a of Object.values(s.agents)) {
      if (!isIdle(a)) continue;
      idle.add(a.id);
      if (!idleIds.has(a.id)) gained = true;
    }
    idleIds = idle;
    // Agents that started a new turn (or went away) drop out at once, without waiting for the server.
    let pruned: Record<string, BackgroundWork> | null = null;
    for (const id of Object.keys(s.background)) {
      if (idle.has(id)) continue;
      pruned ??= { ...s.background };
      delete pruned[id];
    }
    if (pruned) setState({ background: pruned });
    if (gained) void read();
  });

  const onVisible = () => {
    if (document.visibilityState === "visible" && Object.keys(getState().background).length) void read();
  };
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    off();
    clear();
    document.removeEventListener("visibilitychange", onVisible);
  };
}
