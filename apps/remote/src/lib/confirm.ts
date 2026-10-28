import { getState, setState, type ConfirmRequest } from "./store";

/**
 * Ask before doing something consequential (stopping an agent, "always allow",
 * unpairing). Resolves true if confirmed. A newer request replaces (and
 * cancels) one still showing.
 */
export function confirmAction(req: Omit<ConfirmRequest, "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    getState().confirm?.resolve(false);
    setState({ confirm: { ...req, resolve } });
  });
}

export function settleConfirm(ok: boolean) {
  const c = getState().confirm;
  if (!c) return;
  setState({ confirm: null });
  c.resolve(ok);
}
