import { useRef } from "react";

/**
 * Radix only returns focus to a DialogTrigger. Dialogs opened by shortcut or from a menu
 * have none, so focus fell to <body>. Radix calls onOpenAutoFocus before it moves focus in,
 * so capture the focused element there and restore it on close.
 */
export function useReturnFocus(
  handlers: {
    onOpenAutoFocus?: (e: Event) => void;
    onCloseAutoFocus?: (e: Event) => void;
  } = {},
) {
  const returnTo = useRef<Element | null>(null);
  return {
    onOpenAutoFocus: (e: Event) => {
      returnTo.current = document.activeElement;
      handlers.onOpenAutoFocus?.(e);
    },
    onCloseAutoFocus: (e: Event) => {
      handlers.onCloseAutoFocus?.(e);
      if (e.defaultPrevented) return;
      const el = returnTo.current;
      returnTo.current = null;
      if (el instanceof HTMLElement && el.isConnected && el !== document.body) {
        e.preventDefault();
        el.focus({ preventScroll: true });
      }
    },
  };
}
