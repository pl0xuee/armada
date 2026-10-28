// External links never navigate the webview: they're handed to the OS via the
// backend's open_path command (http/https/mailto only).
import { toast } from "sonner";
import { api } from "./api";
import { errorMessage } from "./utils";

const EXTERNAL = /^(https?:|mailto:)/i;

export function isExternalUrl(href: string | null | undefined): href is string {
  return !!href && EXTERNAL.test(href.trim());
}

export async function openExternal(href: string): Promise<void> {
  if (!isExternalUrl(href)) return;
  try {
    await api.openPath(href.trim());
  } catch (e) {
    toast.error("Couldn't open link", { description: errorMessage(e) });
  }
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
    if (e.type === "click" || (e.type === "auxclick" && e.button === 1)) void openExternal(href);
  };
  const blockDrop = (e: DragEvent) => e.preventDefault();
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
