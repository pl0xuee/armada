// Runs the built preview agent (src-tauri/assets/preview-agent.js) against a minimal fake page and checks
// what it reports about location and history. Rebuild the bundle with `npm run build:preview-agent`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RAW_BUNDLE from "../../src-tauri/assets/preview-agent.js?raw";

const TOKEN = "tok";
// The proxy fills in the session secret when it serves the script.
const BUNDLE = RAW_BUNDLE.replaceAll("__KVISTCODE_PREVIEW_KEY__", TOKEN);
const ORIGIN = "http://127.0.0.1:4000";

type Listener = (e: unknown) => void;
interface Posted {
  msg: Record<string, unknown>;
  target: string;
}

/** A page whose agent talks to a stub parent. `nav` fakes the Navigation API when given. */
function boot(opts: { nav?: { canGoBack: boolean; canGoForward: boolean }; historyLength?: number } = {}) {
  const posted: Posted[] = [];
  const listeners: Record<string, Listener[]> = {};
  const parent = { postMessage: (msg: Record<string, unknown>, target: string) => posted.push({ msg, target }) };
  const store = new Map<string, string>();
  class History {
    length = opts.historyLength ?? 1;
    back = vi.fn();
    forward = vi.fn();
    pushState() {
      this.length += 1;
    }
    replaceState() {}
  }
  const win: Record<string, unknown> = {
    parent,
    top: parent,
    location: { href: `${ORIGIN}/` },
    history: new History(),
    History,
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    },
    navigation: opts.nav ? { ...opts.nav, addEventListener: () => undefined } : undefined,
    addEventListener: (n: string, fn: Listener) => (listeners[n] ??= []).push(fn),
    removeEventListener: () => undefined,
    setTimeout,
    clearTimeout,
    console: { error: () => undefined, warn: () => undefined },
  };
  win.window = win;
  win.document = { title: "Home", currentScript: null, addEventListener: () => undefined, documentElement: {} };
  // The bundle is an IIFE that reads window / document / location as globals: hand it ours.
  new Function("window", "document", "location", "console", "setTimeout", "clearTimeout", BUNDLE)(
    win,
    win.document,
    win.location,
    win.console,
    setTimeout,
    clearTimeout,
  );
  const send = (data: Record<string, unknown>) =>
    listeners.message?.forEach((fn) => fn({ data: { kvistcode: "preview-parent", token: TOKEN, ...data }, source: parent, origin: ORIGIN }));
  const navs = () => posted.filter((p) => p.msg.type === "nav").map((p) => p.msg);
  const fire = (name: string) => listeners[name]?.forEach((fn) => fn({}));
  return { win: win as Record<string, any>, posted, send, navs, fire };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("preview agent location reports", () => {
  it("reports the location and history state as soon as the app answers the handshake", () => {
    const p = boot({ nav: { canGoBack: false, canGoForward: false } });
    p.send({ cmd: "init" });
    expect(p.navs()).toEqual([{ kvistcode: "preview", v: 1, token: TOKEN, type: "nav", url: `${ORIGIN}/`, title: "Home", canBack: false, canForward: false }]);
    // Only to the app's origin, never "*" (the handshake alone is tokenless).
    expect(p.posted.filter((x) => x.msg.type === "nav").every((x) => x.target === ORIGIN)).toBe(true);
  });

  it("follows pushState, coalescing a burst into one report", () => {
    const p = boot({ nav: { canGoBack: true, canGoForward: false } });
    p.send({ cmd: "init" });
    p.win.location.href = `${ORIGIN}/a`;
    p.win.history.pushState({}, "", "/a");
    p.win.location.href = `${ORIGIN}/b`;
    p.win.history.pushState({}, "", "/b");
    expect(p.navs()).toHaveLength(1);
    vi.advanceTimersByTime(200);
    const navs = p.navs();
    expect(navs).toHaveLength(2);
    expect(navs[1]).toMatchObject({ url: `${ORIGIN}/b`, canBack: true });
  });

  it("follows popstate and hashchange, and does not repeat an unchanged location", () => {
    const p = boot({ nav: { canGoBack: true, canGoForward: true } });
    p.send({ cmd: "init" });
    p.win.location.href = `${ORIGIN}/#x`;
    p.fire("hashchange");
    p.fire("popstate");
    vi.advanceTimersByTime(200);
    expect(p.navs().map((n) => n.url)).toEqual([`${ORIGIN}/`, `${ORIGIN}/#x`]);
    p.fire("popstate");
    vi.advanceTimersByTime(200);
    expect(p.navs()).toHaveLength(2);
  });

  it("says nothing before the app has answered (no token yet)", () => {
    const p = boot({ nav: { canGoBack: false, canGoForward: false } });
    p.win.history.pushState({}, "", "/early");
    vi.advanceTimersByTime(200);
    expect(p.posted.map((x) => x.msg.type)).toEqual(["hello"]);
  });

  it("without the Navigation API: back is possible after a push, forward after going back", () => {
    const p = boot({ historyLength: 1 });
    p.send({ cmd: "init" });
    expect(p.navs()[0]).toMatchObject({ canBack: false, canForward: false });
    p.win.location.href = `${ORIGIN}/a`;
    p.win.history.pushState({}, "", "/a");
    vi.advanceTimersByTime(200);
    expect(p.navs()[1]).toMatchObject({ url: `${ORIGIN}/a`, canBack: true, canForward: false });
    p.send({ cmd: "history", dir: "back" });
    expect(p.win.history.back).toHaveBeenCalledOnce();
    p.win.location.href = `${ORIGIN}/`;
    p.fire("popstate");
    vi.advanceTimersByTime(200);
    expect(p.navs()[2]).toMatchObject({ url: `${ORIGIN}/`, canForward: true });
    // A new entry drops the forward ones.
    p.win.history.pushState({}, "", "/c");
    vi.advanceTimersByTime(200);
    expect(p.navs().at(-1)).toMatchObject({ canForward: false });
  });
});
