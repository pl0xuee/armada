/** Read a dev-only deep-link parameter (always null in production builds). */
export function devParam(name: string): string | null {
  if (!import.meta.env.DEV) return null;
  return new URLSearchParams(location.search).get(name);
}
