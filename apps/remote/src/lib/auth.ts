import type { Scope } from "./types";
import { storage } from "./storage";

/**
 * Token storage rules:
 * - A token from a link is only a *candidate* until `/api/session` accepts it;
 *   nothing is persisted (or cleared) before that, so a stale QR code or a
 *   share link can never wipe this device's pairing.
 * - The validated pairing lives in localStorage (`armada.token` + its scope).
 * - A read-only share link opened on a device that is already paired as owner
 *   is kept for this tab only (sessionStorage), and the owner pairing stays.
 */
export const TOKEN_KEY = "armada.token";
export const TOKEN_SCOPE_KEY = "armada.tokenScope";
export const SHARED_TOKEN_KEY = "armada.sharedToken";

/** Tokens are URL-safe/base64 strings; anything else pasted is not a token. */
export function isPlausibleToken(t: string): boolean {
  return /^[A-Za-z0-9._~+/=-]{8,1024}$/.test(t);
}

/** Whether a URL fragment carries a pairing code (`pair=`) or a share token (`token=`). */
export function hasTokenParam(hash: string): boolean {
  return /(?:^#|[#&?/])(?:token|pair)=/.test(hash);
}

/** One-time pairing codes are 32 hex characters (device and share tokens are 64). */
export function isPairingCode(t: string): boolean {
  return /^[0-9a-f]{32}$/i.test(t);
}

/** Pull the one-time pairing code out of a fragment like `#pair=<code>`. */
export function pairCodeFromHash(hash: string): string | null {
  const m = /(?:^#|[#&?/])pair=([^&]*)/.exec(hash);
  if (!m) return null;
  let raw = m[1];
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // keep raw
  }
  return isPairingCode(raw) ? raw : null;
}

/**
 * Whether `hostname` is a loopback or private-network address (RFC 1918, carrier-grade NAT such
 * as Tailscale's 100.64.0.0/10, link-local, IPv6 unique-local). Names are not trusted.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (h.includes(":"))
    return (
      h === "::1" ||
      /^f[cd][0-9a-f]{2}:/.test(h) ||
      /^fe[89ab][0-9a-f]:/.test(h)
    );
  return false;
}

/**
 * Pull `token=` out of a hash fragment like `#token=abc` or `#/x?token=abc&y`.
 * Parsed by hand (not URLSearchParams) so base64 `+` isn't turned into a space.
 */
export function tokenFromHash(hash: string): string | null {
  const m = /(?:^#|[#&?/])token=([^&]*)/.exec(hash);
  if (!m) return null;
  let raw = m[1];
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // keep raw
  }
  return isPlausibleToken(raw) ? raw : null;
}

export interface LinkToken {
  /** One-time pairing code from the link (trade it at /api/pair), if any. */
  pairCode: string | null;
  /** Token from the link, not yet validated. */
  candidate: string | null;
  /** A pairing link was present but its token was malformed. */
  malformed: boolean;
}

/**
 * Consume a pairing token from the address bar, scrubbing it from the URL and
 * history so it can't be shoulder-surfed, bookmarked or synced.
 */
export function takeLinkToken(): LinkToken {
  const hash = location.hash;
  if (!hasTokenParam(hash))
    return { pairCode: null, candidate: null, malformed: false };
  const pairCode = pairCodeFromHash(hash);
  const token = pairCode ? null : tokenFromHash(hash);
  history.replaceState(null, "", `${location.pathname}${location.search}#/`);
  return { pairCode, candidate: token, malformed: !pairCode && !token };
}

export interface StoredToken {
  token: string;
  /** "shared" = a share link kept for this tab only. */
  source: "stored" | "shared";
}

/** The token to use when no link is being opened: this tab's share link first, then the pairing. */
export function storedToken(): StoredToken | null {
  const shared = sharedToken();
  if (shared) return { token: shared, source: "shared" };
  const token = storage.get(TOKEN_KEY);
  return token ? { token, source: "stored" } : null;
}

/** The validated pairing, if any (ignores this tab's share link). */
export function pairedToken(): { token: string; scope: Scope | null } | null {
  const token = storage.get(TOKEN_KEY);
  if (!token) return null;
  const scope = storage.get(TOKEN_SCOPE_KEY);
  return {
    token,
    scope: scope === "owner" || scope === "viewer" ? scope : null,
  };
}

/**
 * Persist a token that `/api/session` just accepted. Returns where it went:
 * a viewer link on a device paired as owner stays tab-only.
 */
export function adoptValidatedToken(
  token: string,
  scope: Scope,
): "stored" | "shared" {
  const paired = pairedToken();
  if (
    scope === "viewer" &&
    paired &&
    paired.token !== token &&
    paired.scope !== "viewer"
  ) {
    setShared(token);
    return "shared";
  }
  storage.set(TOKEN_KEY, token);
  storage.set(TOKEN_SCOPE_KEY, scope);
  setShared(null);
  return "stored";
}

function sharedToken(): string | null {
  try {
    return sessionStorage.getItem(SHARED_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setShared(token: string | null) {
  try {
    if (token) sessionStorage.setItem(SHARED_TOKEN_KEY, token);
    else sessionStorage.removeItem(SHARED_TOKEN_KEY);
  } catch {
    // sessionStorage unavailable: the shared view just won't survive a reload.
  }
}

/** Forget the pairing (only if it is still `token`, so a newer pairing survives). */
export function clearPairing(token?: string) {
  if (token && storage.get(TOKEN_KEY) !== token) return;
  storage.remove(TOKEN_KEY);
  storage.remove(TOKEN_SCOPE_KEY);
}

export type PastedPairing =
  | { kind: "pair"; code: string }
  | { kind: "token"; token: string }
  /** A link to another address; `trusted` = a private/loopback address, otherwise the user must confirm. */
  | { kind: "link"; url: string; host: string; trusted: boolean }
  | { kind: "invalid" };

/** Interpret whatever the user pasted on the pairing screen. */
export function parsePasted(input: string): PastedPairing {
  const text = input.trim();
  if (!text) return { kind: "invalid" };
  if (/^https?:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return { kind: "invalid" };
    }
    const code = pairCodeFromHash(url.hash);
    const token = code ? null : tokenFromHash(url.hash);
    if (!code && !token) return { kind: "invalid" };
    if (url.origin === location.origin)
      return code
        ? { kind: "pair", code }
        : { kind: "token", token: token as string };
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return { kind: "invalid" };
    return {
      kind: "link",
      url: url.href,
      host: url.host,
      trusted: isPrivateHost(url.hostname),
    };
  }
  const pairFragment = text.includes("pair=")
    ? pairCodeFromHash(text.startsWith("#") ? text : `#${text}`)
    : null;
  if (pairFragment) return { kind: "pair", code: pairFragment };
  if (isPairingCode(text)) return { kind: "pair", code: text };
  const fromFragment = text.includes("token=")
    ? tokenFromHash(text.startsWith("#") ? text : `#${text}`)
    : null;
  if (fromFragment) return { kind: "token", token: fromFragment };
  return isPlausibleToken(text)
    ? { kind: "token", token: text }
    : { kind: "invalid" };
}
