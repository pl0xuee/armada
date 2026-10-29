// External links never navigate the webview: they're handed to the OS via the
// backend's open_path command (http/https/mailto only).
import { toast } from "sonner";
import { api } from "./api";
import { useUi } from "@/store/ui";
import { openPreview } from "@/store/preview";
import { parseLoopbackUrl } from "./ports";
import { errorMessage, modKey } from "./utils";

const EXTERNAL = /^(https?:|mailto:)/i;

export function isExternalUrl(href: string | null | undefined): href is string {
  return !!href && EXTERNAL.test(href.trim());
}

const HOSTLIKE = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:[/?#]\S*)?$/i;

/**
 * When a link's visible text looks like a URL or hostname but points at a different host,
 * returns the real host (for a "this link goes to ..." check); otherwise null.
 */
export function linkMismatchHost(text: string, href: string | null | undefined): string | null {
  const m = HOSTLIKE.exec(text.trim());
  if (!m || !href) return null;
  let target: string;
  try {
    target = new URL(href.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!target) return null;
  const strip = (h: string) => h.replace(/^www\./, "");
  return strip(m[1].toLowerCase()) === strip(target) ? null : target;
}

export async function openExternal(href: string): Promise<void> {
  if (!isExternalUrl(href)) return;
  try {
    await api.openPath(href.trim());
  } catch (e) {
    toast.error("Couldn't open link", { description: errorMessage(e) });
  }
}

/** Tooltip for links that open in the in-app Preview. */
export const PREVIEW_LINK_HINT = `Open in Preview · ${modKey}+click for browser`;

/** Normalized loopback URL when `href` is an absolute http(s) link to localhost / 127.0.0.1 / [::1]. */
export function loopbackLink(href: string | null | undefined): string | null {
  if (!href || !/^https?:/i.test(href.trim())) return null;
  return parseLoopbackUrl(href);
}

/** Power-user escape hatch: Ctrl/Cmd, Shift, Alt or a non-primary button keeps the OS browser. */
function wantsBrowser(e: Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "button">): boolean {
  return e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0;
}

/** The agent a click belongs to: nearest `[data-agent-id]`, else the one showing in the Agents view. */
export function resolveAgentId(el: Element | null): string | null {
  const tagged = el?.closest?.("[data-agent-id]")?.getAttribute("data-agent-id");
  if (tagged) return tagged;
  const ui = useUi.getState();
  return ui.view === "agents" ? ui.selectedAgentId : null;
}

/**
 * Opens `href` for a click: loopback http(s) links (plain left click, agent resolvable) go to that
 * agent's in-app Preview; everything else to the OS browser. Returns true when it went to Preview.
 */
export function openLink(
  href: string,
  e: Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "button">,
  agentId: string | null,
): boolean {
  const url = loopbackLink(href);
  if (url && agentId && !wantsBrowser(e)) {
    const ui = useUi.getState();
    if (!(ui.view === "agents" && ui.selectedAgentId === agentId)) ui.openAgent(agentId);
    openPreview(agentId, url);
    return true;
  }
  void openExternal(href);
  return false;
}

const LOOPBACK_TEXT = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/[^\s"'<>)\]]*)?/gi;
const MAX_LINKS = 50;

export type TextPart = string | { url: string };

/** Splits plain text into strings and loopback URLs (capped; cheap bail-out when none present). */
export function splitLoopbackUrls(text: string): TextPart[] {
  if (!/(?:localhost|127\.0\.0\.1|\[::1\])/i.test(text)) return [text];
  const parts: TextPart[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(LOOPBACK_TEXT)) {
    if (n >= MAX_LINKS) break;
    const raw = m[0].replace(/[.,;:!?]+$/, "");
    const url = loopbackLink(raw);
    if (!url) continue;
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push({ url: raw });
    last = m.index + raw.length;
    n++;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/**
 * Capture-phase guard for the whole document: any <a href> click (including in
 * agent-rendered markdown) opens externally or is dropped; file drops outside
 * our drop zones can't navigate the webview either.
 */
export function installNavigationGuard(): () => void {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented && e.type === "click") return;
    const a = (e.target as Element | null)?.closest?.("a[href]");
    if (!(a instanceof HTMLAnchorElement)) return;
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) return;
    e.preventDefault();
    // Links with their own click handler (Markdown: mismatch warning, Preview routing) open
    // themselves; opening here too would open twice and skip that handler's checks.
    if (e.type === "click" && a.hasAttribute("data-own-click")) return;
    // Middle-click has no handler of its own there: never let it skip the mismatch warning.
    if (e.type === "auxclick" && a.hasAttribute("data-own-click") && linkMismatchHost(a.textContent ?? "", href)) return;
    // Loopback links open the agent's in-app Preview (unless the visible text names another host).
    if (e.type === "click" && loopbackLink(href) && !linkMismatchHost(a.textContent ?? "", href)) {
      const agentId = resolveAgentId(a);
      if (agentId && !wantsBrowser(e)) {
        e.stopPropagation();
        openLink(href, e, agentId);
        return;
      }
    }
    if (e.type === "click" || (e.type === "auxclick" && e.button === 1)) void openExternal(href);
  };
  // Drop zones (composer, New agent) handle their own events and call preventDefault first;
  // anywhere else a file drop is refused, and must never navigate the webview.
  const blockDrop = (e: DragEvent) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  };
  document.addEventListener("click", onClick, true);
  document.addEventListener("auxclick", onClick, true);
  window.addEventListener("dragover", blockDrop);
  window.addEventListener("drop", blockDrop);
  return () => {
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("auxclick", onClick, true);
    window.removeEventListener("dragover", blockDrop);
    window.removeEventListener("drop", blockDrop);
  };
}
