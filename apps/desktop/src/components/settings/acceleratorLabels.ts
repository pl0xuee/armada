// "CmdOrCtrl+Ctrl+Shift+Space" as the caps a person would read on the keyboard.

const MODIFIERS: Record<string, "ctrl" | "alt" | "shift" | "meta"> = {
  cmdorctrl: "ctrl",
  commandorcontrol: "ctrl",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  altgr: "alt",
  shift: "shift",
  cmd: "meta",
  command: "meta",
  super: "meta",
  meta: "meta",
};

const GLYPHS = {
  mac: { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" },
  other: { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Super" },
} as const;

const ORDER = ["ctrl", "alt", "shift", "meta"] as const;

const KEY_LABELS: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→", plus: "+" };

/**
 * Caps for a Tauri accelerator, modifiers first in the platform's usual order and the key last.
 * On macOS CmdOrCtrl is ⌘; elsewhere it is Ctrl, so it merges with an explicit Ctrl.
 */
export function acceleratorCaps(accelerator: string, mac: boolean): string[] {
  const parts = accelerator
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const mods = new Set<(typeof ORDER)[number]>();
  let key: string | null = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    const mod = MODIFIERS[lower];
    if (!mod) key = KEY_LABELS[lower] ?? (part.length === 1 ? part.toUpperCase() : part);
    else if (mac && (lower === "cmdorctrl" || lower === "commandorcontrol")) mods.add("meta");
    else mods.add(mod);
  }
  const glyphs = GLYPHS[mac ? "mac" : "other"];
  const caps: string[] = ORDER.filter((m) => mods.has(m)).map((m) => glyphs[m]);
  if (key) caps.push(key);
  return caps;
}

/** Two accelerators that press the same keys (case, spacing and Ctrl/CmdOrCtrl aside). Empty never matches. */
export function sameAccelerator(a: string, b: string, mac: boolean): boolean {
  const capsA = acceleratorCaps(a, mac);
  return capsA.length > 0 && capsA.join("+").toLowerCase() === acceleratorCaps(b, mac).join("+").toLowerCase();
}
