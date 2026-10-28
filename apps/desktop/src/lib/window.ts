import { isTauri } from "./api";

/** Window controls; no-ops in the browser mock. */
export async function windowAction(action: "minimize" | "toggleMaximize" | "close") {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  if (action === "minimize") await w.minimize();
  else if (action === "toggleMaximize") await w.toggleMaximize();
  else await w.close();
}

/** Folder picker via the dialog plugin; prompts in the browser mock. */
export async function pickFolder(defaultPath?: string): Promise<string | null> {
  if (!isTauri()) {
    const v = window.prompt("Project folder (browser mock)", defaultPath ?? "/home/sam/Projects/new-project");
    return v?.trim() || null;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ directory: true, multiple: false, defaultPath });
  return typeof res === "string" ? res : null;
}
