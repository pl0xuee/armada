import { useEffect, useRef } from "react";
import { findOption, respondPermission } from "@/lib/actions";
import { approvalActionFor, createArm, shouldIgnoreApprovalKey } from "@/lib/approvalKeys";
import type { Agent, PermissionOption, TimelineItem } from "@/lib/types";
import { usePermissionUi } from "@/store/permissionUi";

export type PermissionItem = Extract<TimelineItem, { kind: "permission" }>;

/** Options picked by kind, never by id (Codex and ACP ids differ). */
export function permissionKeyOptions(item: PermissionItem): {
  allow: PermissionOption | undefined;
  always: PermissionOption | undefined;
  deny: PermissionOption | undefined;
} {
  return {
    allow: findOption(item, ["allow_once"]),
    always: findOption(item, ["allow_always"]),
    deny: findOption(item, ["reject_once", "reject_always"]),
  };
}

/** The newest unresolved permission request in a timeline. */
export function latestPending(items: TimelineItem[] | undefined): PermissionItem | null {
  if (!items) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "permission" && it.resolution === null) return it;
  }
  return null;
}

/** Selector for the card element of a request (set by PermissionCard). */
export const cardSelector = (requestId: string) => `[data-permission-request="${CSS.escape(requestId)}"]`;

/**
 * Keyboard approvals for the visible agent's latest pending request (lib/approvalKeys.ts):
 * A/Y allow once · Shift+A twice always allow · D/N deny · Shift+D/Shift+N deny with a reason ·
 * Enter allows once only while focus is on the card itself. Keys act only while the card is on
 * screen, and never from inputs, buttons, menus or open dialogs.
 */
export function usePermissionKeys(
  agent: Agent,
  items: TimelineItem[] | undefined,
  onDenyWithReason: (requestId: string) => void,
  /** Another side-by-side pane has the keyboard: do nothing. */
  focused = true,
) {
  const pending = focused ? latestPending(items) : null;
  const inflight = useRef(false);
  const arm = useRef(createArm());
  const state = useRef({ agent, pending, onDenyWithReason });
  state.current = { agent, pending, onDenyWithReason };

  useEffect(() => {
    const armer = arm.current;
    if (!pending) return;
    const requestId = pending.requestId;
    const onKey = (e: KeyboardEvent) => {
      const { agent: a, pending: p, onDenyWithReason: deny } = state.current;
      if (!p) return;
      const card = document.querySelector(cardSelector(p.requestId));
      // Enter: only when focus sits on the card itself (not a button inside it).
      const enterOnCard = e.key === "Enter" && !e.shiftKey && card !== null && e.target === card;
      if (!enterOnCard && shouldIgnoreApprovalKey(e)) return;
      if (enterOnCard && (e.repeat || e.isComposing)) return;
      if (!usePermissionUi.getState().visible[p.requestId]) return;
      const action = enterOnCard ? "allow_once" : approvalActionFor(e);
      if (!action) return;
      const opts = permissionKeyOptions(p);
      if (action === "deny_reason") {
        if (!opts.deny) return;
        e.preventDefault();
        deny(p.requestId);
        return;
      }
      let pick: PermissionOption | undefined;
      if (action === "allow_once") pick = opts.allow;
      else if (action === "deny") pick = opts.deny;
      else if (action === "allow_always") {
        if (!opts.always) return;
        e.preventDefault();
        // Irreversible: the first press arms (hint on the card), the second confirms.
        if (!armer.press(p.requestId, (on) => usePermissionUi.getState().setArmed(p.requestId, on))) return;
        pick = opts.always;
      }
      if (!pick || inflight.current) return;
      e.preventDefault();
      inflight.current = true;
      void respondPermission(a.id, p, pick).finally(() => {
        inflight.current = false;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      armer.reset();
      usePermissionUi.getState().setArmed(requestId, false);
    };
  }, [pending]);
}
