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

/** Whether a URL fragment carries a pairing token. */
export function hasTokenParam(hash: string): boolean {
  return /(?:^#|[#&?/])token=/.test(hash);
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
  if (!hasTokenParam(hash)) return { candidate: null, malformed: false };
  const token = tokenFromHash(hash);
  history.replaceState(null, "", `${location.pathname}${location.search}#/`);
  return { candidate: token, malformed: !token };
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
  return { token, scope: scope === "owner" || scope === "viewer" ? scope : null };
}

/**
 * Persist a token that `/api/session` just accepted. Returns where it went:
 * a viewer link on a device paired as owner stays tab-only.
 */
export function adoptValidatedToken(token: string, scope: Scope): "stored" | "shared" {
  const paired = pairedToken();
  if (scope === "viewer" && paired && paired.token !== token && paired.scope !== "viewer") {
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

export type PastedPairing = { kind: "token"; token: string } | { kind: "link"; url: string } | { kind: "invalid" };

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
    const token = tokenFromHash(url.hash);
    if (!token) return { kind: "invalid" };
    if (url.origin === location.origin) return { kind: "token", token };
    return { kind: "link", url: url.href };
  }
  const fromFragment = text.includes("token=") ? tokenFromHash(text.startsWith("#") ? text : `#${text}`) : null;
  if (fromFragment) return { kind: "token", token: fromFragment };
  return isPlausibleToken(text) ? { kind: "token", token: text } : { kind: "invalid" };
}
