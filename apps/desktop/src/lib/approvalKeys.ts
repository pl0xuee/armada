// One approval-key vocabulary everywhere (agent pane, Needs you, Inbox, cheat sheet):
//   A or Y        allow once            (allow_once only)
//   Shift+A       always allow          (press twice within ARM_MS to confirm)
//   D or N        deny                  (reject_once, else reject_always)
//   Shift+D / Shift+N  deny with a reason (agent pane; elsewhere it opens the agent)
//   Enter         allow once, only when focus is inside the approval card
// Keys never fire from inputs, buttons, menus, links, while a dialog/menu is open, or on repeat.

export type ApprovalAction = "allow_once" | "allow_always" | "deny" | "deny_reason";

export const ARM_MS = 2500;

export const APPROVAL_KEYS: { keys: string[]; label: string }[] = [
  { keys: ["A"], label: "Allow once (also Y)" },
  { keys: ["⇧", "A"], label: "Always allow (press twice)" },
  { keys: ["D"], label: "Deny (also N)" },
  { keys: ["⇧", "D"], label: "Deny with a reason" },
];

const BLOCKING_ROLES = new Set([
  "button",
  "combobox",
  "menuitem",
  "menuitemcheckbox",
  "option",
  "link",
  "switch",
  "tab",
  "slider",
  "checkbox",
  "radio",
]);

/** True when a key event must not be treated as an approval shortcut. */
export function shouldIgnoreApprovalKey(e: KeyboardEvent): boolean {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return true;
  if (e.isComposing || e.keyCode === 229) return true;
  const t = e.target;
  if (t instanceof HTMLElement) {
    const tag = t.tagName;
    if (
      t.isContentEditable ||
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      tag === "BUTTON" ||
      tag === "A"
    )
      return true;
    const role = t.getAttribute("role");
    if (role && BLOCKING_ROLES.has(role)) return true;
  }
  return !!document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
  );
}

/** Map a key event to an approval action (call shouldIgnoreApprovalKey first). */
export function approvalActionFor(e: KeyboardEvent): ApprovalAction | null {
  const k = e.key.toLowerCase();
  if (k === "a" || k === "y") return e.shiftKey ? (k === "a" ? "allow_always" : null) : "allow_once";
  if (k === "d" || k === "n") return e.shiftKey ? "deny_reason" : "deny";
  return null;
}

/**
 * Two-step confirm for irreversible "always allow": the first press arms (show a hint),
 * a second press within ARM_MS confirms. Returns true when the action should run now.
 */
export function createArm() {
  let armedKey: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    press(key: string, onChange?: (armed: boolean) => void): boolean {
      if (armedKey === key) {
        armedKey = null;
        if (timer) clearTimeout(timer);
        onChange?.(false);
        return true;
      }
      armedKey = key;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        armedKey = null;
        onChange?.(false);
      }, ARM_MS);
      onChange?.(true);
      return false;
    },
    reset() {
      armedKey = null;
      if (timer) clearTimeout(timer);
    },
  };
}
