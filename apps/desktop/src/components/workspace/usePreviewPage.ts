// Connects the Preview iframe to the preview agent that the local proxy injects into the page:
// starts/stops the per-agent proxy, performs the postMessage handshake, collects console problems and
// exposes screenshot / element-picker commands. Everything from the page is validated first
// (origin, source window, token, shape: see lib/previewBridge.ts) and treated as plain data.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  addEntry,
  parseAgentMessage,
  type AgentEvent,
  type ConsoleEntry,
  type PickedElement,
  type ShotResult,
} from "@/lib/previewBridge";

/** How long after the page loads the agent may take to say hello before the tools count as unavailable. */
const AGENT_WAIT_MS = 5000;
const SHOT_TIMEOUT_MS = 30_000;

export type PageTools =
  | "off" // tools switched off, or a target the proxy can't front (https): the page loads directly
  | "starting"
  | "waiting" // the page is loading
  | "ready"
  | "unavailable"; // the page didn't run the agent (strict CSP, non-HTML...)

// Starts and stops for one agent must not overtake each other (Tauri runs async commands concurrently).
const chains = new Map<string, Promise<unknown>>();
function enqueue<T>(agentId: string, job: () => Promise<T>): Promise<T> {
  const next = (chains.get(agentId) ?? Promise.resolve()).catch(() => undefined).then(job);
  chains.set(agentId, next);
  return next;
}

interface Session {
  key: string;
  /** The proxy URL's origin (what `event.origin` must equal). */
  origin: string;
  token: string;
  simulated: boolean;
}

export interface PageHandlers {
  picked: (info: PickedElement) => void;
  pickShot: (selector: string, result: ShotResult) => void;
}

const SAMPLE: Omit<ConsoleEntry, "at">[] = [
  { key: "error|exception|s1", level: "error", kind: "exception", message: "TypeError: Cannot read properties of undefined (reading 'map')", stack: "at TaskList (src/TaskList.tsx:24:18)\nat renderWithHooks (react-dom.js:15486:18)", count: 3 },
  { key: "warn|console|s2", level: "warn", kind: "console", message: "Warning: Each child in a list should have a unique \"key\" prop.", stack: "", count: 1 },
  { key: "error|resource|s3", level: "error", kind: "resource", message: "Failed to load <img> /assets/hero.png", stack: "", count: 1 },
];

export function usePreviewPage(opts: {
  agentId: string;
  /** The real dev-server URL (loopback), or null. */
  url: string | null;
  enabled: boolean;
  /** Changes whenever the iframe is re-created (reload, new URL). */
  frameKey: string;
  handlers: PageHandlers;
}) {
  const { agentId, url, enabled, frameKey } = opts;
  const [session, setSession] = useState<Session | null>(null);
  const [starting, setStarting] = useState(false);
  const [agent, setAgent] = useState<"waiting" | "ready" | "unavailable">("waiting");
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [inspecting, setInspecting] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const handlers = useRef(opts.handlers);
  handlers.current = opts.handlers;
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;
  const pending = useRef(new Map<string, (r: ShotResult) => void>());
  const loadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The proxy fronts one dev server (origin). Changing only the path reuses it.
  let targetKey = "";
  try {
    if (url && enabled) {
      const u = new URL(url);
      if (u.protocol === "http:") targetKey = u.origin;
    }
  } catch {
    /* invalid URL: no proxy */
  }

  useEffect(() => {
    if (!targetKey) {
      setSession(null);
      setStarting(false);
      return;
    }
    let cancelled = false;
    let token: string | undefined;
    setStarting(true);
    void enqueue(agentId, () => api.previewProxyStart(agentId, targetKey))
      .then((info) => {
        token = info.token;
        if (cancelled) return;
        setSession({ key: targetKey, origin: new URL(info.url).origin, token: info.token, simulated: !!info.simulated });
        setStarting(false);
      })
      .catch(() => {
        // No proxy (e.g. the port can't be opened): the page still previews, without the tools.
        if (!cancelled) {
          setSession(null);
          setStarting(false);
        }
      });
    return () => {
      cancelled = true;
      setSession(null);
      void enqueue(agentId, async () => {
        // `token` is only known once the start finished; stop whatever session this effect created.
        await api.previewProxyStop(agentId, token).catch(() => undefined);
      });
    };
  }, [agentId, targetKey]);

  /** What the iframe should load: the real URL's path on the proxy origin (or the URL itself without tools). */
  let frameSrc: string | null = url;
  if (url && session && targetKey === session.key) {
    try {
      const u = new URL(url);
      frameSrc = `${session.origin}${u.pathname}${u.search}${u.hash}`;
    } catch {
      frameSrc = url;
    }
  }
  const frameReady = !!url && (!targetKey || !starting);
  const tools: PageTools = !targetKey
    ? "off"
    : starting
      ? "starting"
      : !session
        ? "off"
        : agent === "ready"
          ? "ready"
          : agent === "unavailable"
            ? "unavailable"
            : "waiting";

  const send = useCallback((msg: Record<string, unknown>) => {
    const s = sessionRef.current;
    const win = iframeRef.current?.contentWindow;
    if (!s || !win) return false;
    win.postMessage({ armada: "preview-parent", token: s.token, ...msg }, s.origin);
    return true;
  }, []);

  // New iframe: the agent hasn't spoken yet.
  useEffect(() => {
    setAgent("waiting");
    setInspecting(false);
    clearTimeout(loadTimer.current);
    return () => clearTimeout(loadTimer.current);
  }, [frameKey, session?.token]);

  /** Call from the iframe's onLoad. */
  const onFrameLoad = useCallback(() => {
    send({ cmd: "ping" });
    clearTimeout(loadTimer.current);
    loadTimer.current = setTimeout(() => setAgent((a) => (a === "waiting" ? "unavailable" : a)), AGENT_WAIT_MS);
  }, [send]);

  useEffect(() => {
    if (!session) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== session.origin || !iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      const ev: AgentEvent | null = parseAgentMessage(e.data, session.token);
      if (!ev) return;
      switch (ev.type) {
        case "hello":
          // A new document: hand over the token (only to the proxy origin), forget the old page's problems.
          (e.source as Window).postMessage({ armada: "preview-parent", token: session.token, cmd: "init" }, session.origin);
          setEntries([]);
          setInspecting(false);
          break;
        case "ready":
          clearTimeout(loadTimer.current);
          setAgent("ready");
          break;
        case "console":
          setEntries((cur) => addEntry(cur, ev.entry));
          break;
        case "shot": {
          const done = pending.current.get(ev.id);
          pending.current.delete(ev.id);
          done?.(ev.result);
          break;
        }
        case "picked":
          handlers.current.picked(ev.info);
          break;
        case "pick-shot":
          handlers.current.pickShot(ev.selector, ev.result);
          break;
        case "inspect-state":
          setInspecting(ev.on);
          break;
      }
    };
    window.addEventListener("message", onMessage);
    const waiting = pending.current;
    return () => {
      window.removeEventListener("message", onMessage);
      for (const done of waiting.values()) done({ ok: false, error: "The preview was closed" });
      waiting.clear();
    };
  }, [session]);

  // In the browser mock there is no proxy to inject the agent: show sample problems so the panel can be tried.
  useEffect(() => {
    if (session?.simulated && agent === "unavailable") setEntries((cur) => (cur.length ? cur : SAMPLE.reduce((l, s) => addEntry(l, s), [] as ConsoleEntry[])));
  }, [session, agent]);

  const screenshot = useCallback((): Promise<ShotResult> => {
    const id = Math.random().toString(36).slice(2);
    return new Promise<ShotResult>((resolve) => {
      const timer = setTimeout(() => {
        pending.current.delete(id);
        resolve({ ok: false, error: "The page took too long to capture" });
      }, SHOT_TIMEOUT_MS);
      pending.current.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      if (!send({ cmd: "screenshot", id })) {
        clearTimeout(timer);
        pending.current.delete(id);
        resolve({ ok: false, error: "The page isn't ready" });
      }
    });
  }, [send]);

  const inspect = useCallback(
    (on: boolean, shot: boolean) => {
      if (send({ cmd: "inspect", on, shot })) setInspecting(on);
    },
    [send],
  );

  const clear = useCallback(() => setEntries([]), []);

  return { iframeRef, frameSrc, frameReady, tools, simulated: !!session?.simulated, entries, clear, inspecting, inspect, screenshot, onFrameLoad };
}
