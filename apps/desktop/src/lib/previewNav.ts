// Turns a location reported by the preview agent into the address the user sees. The page runs on the
// local proxy's origin, but the address bar (and the remembered per-project address) always show the
// dev server's own. Nothing from the page is trusted beyond its path, query and hash: the origin is
// always the dev server's, and the result must still be a loopback URL.
import { parseLoopbackUrl } from "@/lib/ports";

/**
 * The dev-server URL for `pageUrl` (as reported by the agent), or null when the page isn't on the proxy
 * origin (it navigated away) or the result isn't a loopback URL.
 */
export function devUrlFromPage(pageUrl: string, proxyOrigin: string, devOrigin: string): string | null {
  let u: URL;
  try {
    u = new URL(pageUrl);
  } catch {
    return null;
  }
  if (u.origin !== proxyOrigin) return null;
  return parseLoopbackUrl(`${devOrigin}${u.pathname}${u.search}${u.hash}`);
}
