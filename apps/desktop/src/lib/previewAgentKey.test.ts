// The built preview agent (the script the Preview proxy injects into the page) must only take orders from
// a parent frame that knows the proxy's session secret: any website can frame the proxy's loopback port,
// and without this it would hand that site screenshots of the page.
import { describe, expect, it } from "vitest";
import BUNDLE from "../../src-tauri/assets/preview-agent.js?raw";

const PLACEHOLDER = "__KVISTCODE_PREVIEW_KEY__";
const KEY = "0123456789abcdef0123456789abcdef";

interface Posted {
  msg: Record<string, unknown>;
  target: string;
}

/** Runs the bundle as the page inside a Preview iframe, with a stand-in window and parent. */
function load(key: string) {
  const posted: Posted[] = [];
  const handlers: Record<string, ((e: unknown) => void)[]> = {};
  const parent = {
    postMessage: (msg: Record<string, unknown>, target: string) => posted.push({ msg, target }),
  };
  const noop = () => undefined;
  const win: Record<string, any> = {
    parent,
    top: parent,
    addEventListener: (type: string, fn: (e: unknown) => void) => (handlers[type] ??= []).push(fn),
    removeEventListener: noop,
    innerWidth: 800,
    innerHeight: 600,
    history: { length: 1, back: noop, forward: noop, pushState: noop, replaceState: noop },
    sessionStorage: { getItem: () => null, setItem: noop },
    setTimeout,
    clearTimeout,
    getComputedStyle: () => ({ backgroundColor: "rgb(255, 255, 255)" }),
  };
  win.window = win;
  const el = { nodeType: 1, style: {}, appendChild: noop };
  const doc = { addEventListener: noop, documentElement: el, body: el, title: "t", createElement: () => ({ style: {} }) };
  win.document = doc;
  const quiet = { log: noop, info: noop, debug: noop, warn: noop, error: noop };
  // The bundle is an IIFE that reads window / document / location as globals: hand it ours.
  new Function("window", "document", "console", "location", "getComputedStyle", BUNDLE.replaceAll(PLACEHOLDER, key))(
    win,
    doc,
    quiet,
    { href: "http://127.0.0.1:49500/" },
    win.getComputedStyle,
  );
  const send = (data: unknown, origin: string, source: unknown = parent) =>
    handlers.message?.forEach((fn) => fn({ data, origin, source }));
  return { posted, send };
}

const order = (token: string, cmd = "ping") => ({ kvistcode: "preview-parent", token, cmd });

describe("preview agent parent check", () => {
  it("ships with the key placeholder for the proxy to fill in", () => {
    expect(BUNDLE).toContain(PLACEHOLDER);
  });

  it("says hello to its embedder but ignores a parent that doesn't know the key", () => {
    const { posted, send } = load(KEY);
    // The hello goes to whoever embeds the page, so it says nothing about the page (not even its URL).
    const hello = posted.filter((p) => p.msg.type === "hello");
    expect(hello.length).toBeGreaterThan(0);
    for (const h of hello) expect(Object.keys(h.msg).sort()).toEqual(["kvistcode", "type", "v"]);
    send(order("attacker"), "https://evil.example");
    send(order("attacker", "screenshot"), "https://evil.example");
    expect(posted.filter((p) => p.msg.type !== "hello")).toEqual([]);
  });

  it("works with the app, which holds the key", () => {
    const { posted, send } = load(KEY);
    send(order(KEY, "init"), "tauri://localhost");
    const ready = posted.find((p) => p.msg.type === "ready");
    expect(ready?.target).toBe("tauri://localhost");
    expect(ready?.msg.token).toBe(KEY);
    // A site that frames the page afterwards still can't give orders.
    const before = posted.length;
    send(order("attacker"), "https://evil.example");
    expect(posted.length).toBe(before);
  });

  it("ignores messages that don't come from its parent frame", () => {
    const { posted, send } = load(KEY);
    send(order(KEY, "init"), "tauri://localhost", {});
    expect(posted.filter((p) => p.msg.type !== "hello")).toEqual([]);
  });
});
