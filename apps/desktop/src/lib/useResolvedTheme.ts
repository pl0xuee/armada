import { useSyncExternalStore } from "react";
import { resolveTheme, systemPrefersLight, type ThemeId } from "@/lib/themes";

const QUERY = "(prefers-color-scheme: light)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** The theme to draw right now; follows the OS light/dark setting while "Match system" is chosen. */
export function useResolvedTheme(choice: string | undefined): ThemeId {
  const prefersLight = useSyncExternalStore(subscribe, systemPrefersLight, () => false);
  return resolveTheme(choice, prefersLight);
}
