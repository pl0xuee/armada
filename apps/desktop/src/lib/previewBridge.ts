// Parent side of the Preview pane's page link. The page (through the local preview proxy) runs the
// preview agent, which reports with window.parent.postMessage. Nothing from the page is ever executed:
// messages are checked (origin, source, token, shape), clamped to small sizes and turned into plain data.
import { MAX_ATTACHMENT_BYTES } from "@/lib/attachments";
import type { Attachment } from "@/lib/types";

export const MAX_DATA_URL_CHARS = 8_000_000;
export const MAX_ENTRIES = 100;

export type Level = "error" | "warn";

export interface ConsoleEntry {
  key: string;
  level: Level;
  kind: "console" | "exception" | "rejection" | "resource";
  message: string;
  /** Top stack frames, one per line. */
  stack: string;
  count: number;
  at: number;
}

export interface PickedElement {
  selector: string;
  tag: string;
  id: string;
  classes: string[];
  text: string;
  attrs: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
}

export type ShotResult =
  | { ok: true; dataUrl: string; mime: string; width: number; height: number }
  | { ok: false; error: string };

export type AgentEvent =
  | { type: "hello" }
  | { type: "ready"; url: string; title: string }
  | { type: "console"; entry: Omit<ConsoleEntry, "at"> }
  | { type: "shot"; id: string; result: ShotResult }
  | { type: "picked"; info: PickedElement }
  | { type: "pick-shot"; selector: string; result: ShotResult }
  | { type: "inspect-state"; on: boolean };

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseShot(d: Record<string, unknown>): ShotResult {
  if (d.ok !== true) return { ok: false, error: str(d.error, 200) || "Capture failed" };
  const dataUrl = typeof d.dataUrl === "string" ? d.dataUrl : "";
  const mime = d.mime === "image/jpeg" ? "image/jpeg" : "image/png";
  if (!dataUrl.startsWith(`data:${mime};base64,`) || dataUrl.length > MAX_DATA_URL_CHARS) {
    return { ok: false, error: "The page sent an unusable image" };
  }
  return { ok: true, dataUrl, mime, width: num(d.width), height: num(d.height) };
}

/**
 * Validates one `message` event's data. `hello` (the handshake) carries no token; everything else must
 * carry `token`. Returns null for anything that isn't a well-formed agent message. The caller checks
 * `event.origin` and `event.source` first.
 */
export function parseAgentMessage(data: unknown, token: string): AgentEvent | null {
  if (!isObj(data) || data.armada !== "preview" || data.v !== 1 || typeof data.type !== "string") return null;
  if (data.type === "hello") return { type: "hello" };
  if (!token || data.token !== token) return null;
  switch (data.type) {
    case "ready":
      return { type: "ready", url: str(data.url, 2000), title: str(data.title, 200) };
    case "console": {
      const level: Level = data.level === "warn" ? "warn" : "error";
      const kind = (["console", "exception", "rejection", "resource"] as const).find((k) => k === data.kind) ?? "console";
      const message = str(data.message, 1500);
      if (!message) return null;
      return {
        type: "console",
        entry: { key: `${level}|${kind}|${message.slice(0, 200)}`, level, kind, message, stack: str(data.stack, 800), count: Math.max(1, num(data.count)) },
      };
    }
    case "shot":
      return { type: "shot", id: str(data.id, 64), result: parseShot(data) };
    case "pick-shot":
      return { type: "pick-shot", selector: str(data.selector, 400), result: parseShot(data) };
    case "picked": {
      const i = data.info;
      if (!isObj(i)) return null;
      const attrs: Record<string, string> = {};
      if (isObj(i.attrs)) {
        for (const [k, v] of Object.entries(i.attrs).slice(0, 10)) if (typeof v === "string") attrs[k.slice(0, 40)] = v.slice(0, 120);
      }
      const rect = isObj(i.rect) ? i.rect : {};
      const vp = isObj(i.viewport) ? i.viewport : {};
      const selector = str(i.selector, 400);
      if (!selector) return null;
      return {
        type: "picked",
        info: {
          selector,
          tag: str(i.tag, 40),
          id: str(i.id, 80),
          classes: Array.isArray(i.classes) ? i.classes.slice(0, 8).map((c) => str(c, 60)).filter(Boolean) : [],
          text: str(i.text, 120),
          attrs,
          rect: { x: num(rect.x), y: num(rect.y), width: num(rect.width), height: num(rect.height) },
          viewport: { width: num(vp.width), height: num(vp.height) },
        },
      };
    }
    case "inspect-state":
      return { type: "inspect-state", on: data.on === true };
    default:
      return null;
  }
}

/** Adds an entry, merging repeats (same level, kind and message) and keeping the newest MAX_ENTRIES. */
export function addEntry(list: ConsoleEntry[], e: Omit<ConsoleEntry, "at">, at = Date.now()): ConsoleEntry[] {
  const i = list.findIndex((x) => x.key === e.key);
  if (i >= 0) {
    const next = list.slice();
    // The agent reports a running count (it thins out repeats), so take the larger.
    next[i] = { ...next[i], count: Math.max(next[i].count, e.count), at, stack: next[i].stack || e.stack };
    return next;
  }
  const next = [...list, { ...e, at }];
  return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
}

export function counts(list: ConsoleEntry[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const e of list) (e.level === "error" ? (errors += 1) : (warnings += 1));
  return { errors, warnings };
}

/** Makes proxy-origin URLs in text read as the dev server's own (the user never sees the proxy). */
export function unproxy(text: string, proxyOrigin: string, devOrigin: string): string {
  return proxyOrigin ? text.split(proxyOrigin).join(devOrigin) : text;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** A concise summary of the page's console problems for the composer: most recent first, bounded. */
export function formatErrorsSummary(
  list: ConsoleEntry[],
  ctx: { pageUrl: string; proxyOrigin: string; devOrigin: string },
  max = 8,
): string {
  const { errors, warnings } = counts(list);
  const head = [errors && plural(errors, "error"), warnings && plural(warnings, "warning")].filter(Boolean).join(", ");
  const fix = (s: string) => unproxy(s, ctx.proxyOrigin, ctx.devOrigin);
  const items = list
    .slice()
    .sort((a, b) => (a.level === b.level ? b.at - a.at : a.level === "error" ? -1 : 1))
    .slice(0, max);
  const lines = [`Console problems on ${ctx.pageUrl} (${head || "none"}):`];
  items.forEach((e, i) => {
    const msg = fix(e.message).replace(/\s+/g, " ").trim();
    lines.push(`${i + 1}. [${e.level}] ${msg.length > 300 ? `${msg.slice(0, 299)}…` : msg}${e.count > 1 ? ` (×${e.count})` : ""}`);
    for (const f of fix(e.stack).split("\n").filter(Boolean).slice(0, 3)) lines.push(`   ${f.length > 160 ? `${f.slice(0, 159)}…` : f}`);
  });
  if (list.length > items.length) lines.push(`…and ${plural(list.length - items.length, "more distinct problem")}.`);
  const out = lines.join("\n");
  return out.length > 4000 ? `${out.slice(0, 3999)}…` : out;
}

/** The composer text for a picked element. */
export function formatPicked(info: PickedElement, ctx: { pageUrl: string; width: number | null }): string {
  const w = ctx.width ? `device width ${ctx.width}px` : "responsive width";
  const attrs = Object.entries(info.attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  const open = `<${info.tag}${info.id ? ` id="${info.id}"` : ""}${info.classes.length ? ` class="${info.classes.join(" ")}"` : ""}>`;
  const r = info.rect;
  return [
    `Element in the preview of ${ctx.pageUrl} (${w}):`,
    `- selector: \`${info.selector}\``,
    `- ${open}${info.text ? ` text: "${info.text}"` : ""}`,
    `- box: ${r.width}×${r.height} at (${r.x}, ${r.y}) in a ${info.viewport.width}×${info.viewport.height} viewport`,
    ...(attrs ? [`- attributes: ${attrs}`] : []),
  ].join("\n");
}

/** A captured data URL as a composer attachment, or an error message when it can't be used. */
export function shotToAttachment(
  r: Extract<ShotResult, { ok: true }>,
  name: string,
): { ok: true; attachment: Attachment } | { ok: false; error: string } {
  const comma = r.dataUrl.indexOf(",");
  const data = r.dataUrl.slice(comma + 1);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data.slice(0, 4096))) return { ok: false, error: "The page sent an unusable image" };
  if ((data.length * 3) / 4 > MAX_ATTACHMENT_BYTES) return { ok: false, error: "The screenshot is larger than 5 MB" };
  const ext = r.mime === "image/jpeg" ? "jpg" : "png";
  return { ok: true, attachment: { name: `${name}.${ext}`, mimeType: r.mime, data } };
}
