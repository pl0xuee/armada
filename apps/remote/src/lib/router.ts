import { useSyncExternalStore } from "react";

/**
 * Hash routing: the desktop server only serves `/`, and the hash never reaches
 * the server (or its logs). Routes: `#/`, `#/agent/<id>`, `#/inbox`.
 */
export type Route =
  | { name: "fleet" }
  | { name: "agent"; agentId: string }
  | { name: "review"; agentId: string }
  | { name: "inbox" }
  | { name: "new" };

const ROUTE_EVENT = "armada:route";

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "");
  const agent = /^\/agent\/([^/?#]+)(\/review)?/.exec(path);
  if (agent) {
    try {
      const agentId = decodeURIComponent(agent[1]);
      return agent[2] ? { name: "review", agentId } : { name: "agent", agentId };
    } catch {
      return { name: "fleet" };
    }
  }
  if (path.startsWith("/inbox")) return { name: "inbox" };
  if (path === "/new" || path.startsWith("/new?")) return { name: "new" };
  return { name: "fleet" };
}

export function routeHash(route: Route): string {
  switch (route.name) {
    case "agent":
      return `#/agent/${encodeURIComponent(route.agentId)}`;
    case "review":
      return `#/agent/${encodeURIComponent(route.agentId)}/review`;
    case "inbox":
      return "#/inbox";
    case "new":
      return "#/new";
    default:
      return "#/";
  }
}

let current: Route = parseRoute(location.hash);
let currentKey = location.hash;

function refresh() {
  if (location.hash === currentKey) return;
  currentKey = location.hash;
  current = parseRoute(location.hash);
}

function subscribe(cb: () => void) {
  const handler = () => {
    refresh();
    cb();
  };
  window.addEventListener("hashchange", handler);
  window.addEventListener("popstate", handler);
  window.addEventListener(ROUTE_EVENT, handler);
  return () => {
    window.removeEventListener("hashchange", handler);
    window.removeEventListener("popstate", handler);
    window.removeEventListener(ROUTE_EVENT, handler);
  };
}

/** Re-read the location after it was changed without an event (e.g. `replaceState`). */
export function notifyRouteChange() {
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, () => current);
}

export function getRoute(): Route {
  refresh();
  return current;
}

interface HistoryMark {
  armada: true;
  depth: number;
}

function depth(): number {
  const s = history.state as Partial<HistoryMark> | null;
  return s?.armada ? (s.depth ?? 0) : 0;
}

export function navigate(route: Route, opts: { replace?: boolean } = {}) {
  const hash = routeHash(route);
  if (hash === location.hash || (hash === "#/" && location.hash === "")) return;
  const url = `${location.pathname}${location.search}${hash}`;
  if (opts.replace) {
    history.replaceState({ armada: true, depth: depth() } satisfies HistoryMark, "", url);
  } else {
    history.pushState({ armada: true, depth: depth() + 1 } satisfies HistoryMark, "", url);
  }
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

/** In-app "back": pop our own history entry when there is one, else go to the fleet. */
export function goBack() {
  if (depth() > 0) history.back();
  else navigate({ name: "fleet" }, { replace: true });
}
