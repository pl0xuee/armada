import { describe, expect, it } from "vitest";
import {
  addEntry,
  counts,
  formatErrorsSummary,
  formatPicked,
  MAX_ENTRIES,
  parseAgentMessage,
  shotToAttachment,
  unproxy,
  type ConsoleEntry,
} from "./previewBridge";

const T = "tok";
const msg = (o: Record<string, unknown>) => ({ armada: "preview", v: 1, token: T, ...o });

describe("parseAgentMessage", () => {
  it("accepts the tokenless handshake only as hello", () => {
    expect(parseAgentMessage({ armada: "preview", v: 1, type: "hello" }, T)).toEqual({ type: "hello" });
    expect(parseAgentMessage({ armada: "preview", v: 1, type: "ready", url: "x" }, T)).toBeNull();
  });
  it("rejects wrong token, wrong envelope and junk", () => {
    expect(parseAgentMessage(msg({ type: "ready", token: "nope" }), T)).toBeNull();
    expect(parseAgentMessage({ ...msg({ type: "ready" }), armada: "other" }, T)).toBeNull();
    expect(parseAgentMessage({ ...msg({ type: "ready" }), v: 2 }, T)).toBeNull();
    for (const j of [null, 3, "x", [], undefined]) expect(parseAgentMessage(j, T)).toBeNull();
    expect(parseAgentMessage(msg({ type: "eval", code: "alert(1)" }), T)).toBeNull();
    expect(parseAgentMessage(msg({ type: "ready" }), "")).toBeNull();
  });
  it("clamps console messages and ignores empty ones", () => {
    const e = parseAgentMessage(msg({ type: "console", level: "warn", kind: "console", message: "x".repeat(5000), stack: "s".repeat(5000), count: 3 }), T);
    expect(e?.type === "console" && e.entry.message.length).toBe(1500);
    expect(e?.type === "console" && e.entry.stack.length).toBe(800);
    expect(e?.type === "console" && e.entry.level).toBe("warn");
    expect(parseAgentMessage(msg({ type: "console", message: "" }), T)).toBeNull();
    const odd = parseAgentMessage(msg({ type: "console", level: "<script>", kind: "weird", message: "m" }), T);
    expect(odd?.type === "console" && [odd.entry.level, odd.entry.kind]).toEqual(["error", "console"]);
  });
  it("only accepts image data URLs of the declared type and bounded size", () => {
    const ok = parseAgentMessage(msg({ type: "shot", id: "1", ok: true, dataUrl: "data:image/png;base64,AAAA", mime: "image/png", width: 10, height: 5 }), T);
    expect(ok).toMatchObject({ type: "shot", result: { ok: true, width: 10 } });
    const bad = parseAgentMessage(msg({ type: "shot", id: "1", ok: true, dataUrl: "data:text/html;base64,AAAA", mime: "image/png" }), T);
    expect(bad).toMatchObject({ result: { ok: false } });
    const big = parseAgentMessage(msg({ type: "shot", id: "1", ok: true, dataUrl: `data:image/png;base64,${"A".repeat(9_000_000)}`, mime: "image/png" }), T);
    expect(big).toMatchObject({ result: { ok: false } });
  });
  it("sanitizes a picked element", () => {
    const e = parseAgentMessage(
      msg({ type: "picked", info: { selector: "main > button", tag: "button", id: "", classes: ["a", 5, "b"], text: "Save", attrs: { role: "button", bad: 3 }, rect: { x: 1.4, y: 2, width: 30, height: "x" }, viewport: { width: 390, height: 800 } } }),
      T,
    );
    expect(e).toMatchObject({ type: "picked", info: { classes: ["a", "b"], attrs: { role: "button" }, rect: { x: 1, width: 30, height: 0 } } });
    expect(parseAgentMessage(msg({ type: "picked", info: { selector: "" } }), T)).toBeNull();
  });
});

const entry = (message: string, o: Partial<ConsoleEntry> = {}): Omit<ConsoleEntry, "at"> => ({
  key: `error|console|${message}`,
  level: "error",
  kind: "console",
  message,
  stack: "",
  count: 1,
  ...o,
});

describe("addEntry", () => {
  it("dedupes by key and keeps the highest count and first stack", () => {
    let l: ConsoleEntry[] = [];
    l = addEntry(l, entry("boom", { stack: "at a (x.js:1:1)" }), 1);
    l = addEntry(l, entry("boom", { count: 4 }), 2);
    l = addEntry(l, entry("boom", { count: 2 }), 3);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ count: 4, at: 3, stack: "at a (x.js:1:1)" });
  });
  it("is bounded, dropping the oldest", () => {
    let l: ConsoleEntry[] = [];
    for (let i = 0; i < MAX_ENTRIES + 20; i++) l = addEntry(l, entry(`m${i}`));
    expect(l).toHaveLength(MAX_ENTRIES);
    expect(l[0].message).toBe("m20");
  });
});

describe("formatErrorsSummary", () => {
  const ctx = { pageUrl: "http://localhost:3000/", proxyOrigin: "http://127.0.0.1:50000", devOrigin: "http://localhost:3000" };
  it("lists errors first with counts and top frames, hiding the proxy", () => {
    let l: ConsoleEntry[] = [];
    l = addEntry(l, entry("careful", { level: "warn", key: "warn|console|careful" }), 1);
    l = addEntry(l, entry("TypeError: x is undefined", { count: 4, stack: "at App (http://127.0.0.1:50000/src/App.tsx:12:5)\nat b\nat c\nat d" }), 2);
    const s = formatErrorsSummary(l, ctx);
    expect(s.split("\n")[0]).toBe("Console problems on http://localhost:3000/ (1 error, 1 warning):");
    expect(s).toContain("1. [error] TypeError: x is undefined (×4)");
    expect(s).toContain("   at App (http://localhost:3000/src/App.tsx:12:5)");
    expect(s).not.toContain("127.0.0.1");
    expect(s).not.toContain("at d");
    expect(s.indexOf("[error]")).toBeLessThan(s.indexOf("[warn]"));
  });
  it("truncates long output", () => {
    let l: ConsoleEntry[] = [];
    for (let i = 0; i < 30; i++) l = addEntry(l, entry(`e${i} ${"y".repeat(400)}`));
    const s = formatErrorsSummary(l, ctx);
    expect(s.length).toBeLessThanOrEqual(4000);
    expect(s).toContain("…and 22 more distinct problems.");
    expect(counts(l)).toEqual({ errors: 30, warnings: 0 });
  });
});

describe("formatPicked / shotToAttachment / unproxy", () => {
  it("formats the reference", () => {
    const t = formatPicked(
      { selector: "main > button.btn", tag: "button", id: "go", classes: ["btn"], text: "Save", attrs: { role: "button" }, rect: { x: 10, y: 20, width: 100, height: 30 }, viewport: { width: 390, height: 800 } },
      { pageUrl: "http://localhost:3000/", width: 390 },
    );
    expect(t).toContain("(device width 390px)");
    expect(t).toContain("`main > button.btn`");
    expect(t).toContain('<button id="go" class="btn"> text: "Save"');
    expect(t).toContain("100×30 at (10, 20) in a 390×800 viewport");
  });
  it("turns a capture into an attachment within the size limit", () => {
    const r = shotToAttachment({ ok: true, dataUrl: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png", width: 1, height: 1 }, "preview");
    expect(r).toEqual({ ok: true, attachment: { name: "preview.png", mimeType: "image/png", data: "iVBORw0KGgo=" } });
    const big = shotToAttachment({ ok: true, dataUrl: `data:image/png;base64,${"A".repeat(7_500_000)}`, mime: "image/png", width: 1, height: 1 }, "p");
    expect(big.ok).toBe(false);
  });
  it("unproxy swaps origins", () => {
    expect(unproxy("a http://p/x b http://p/y", "http://p", "http://d")).toBe("a http://d/x b http://d/y");
    expect(unproxy("keep", "", "http://d")).toBe("keep");
  });
});
