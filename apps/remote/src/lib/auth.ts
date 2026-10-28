import { storage } from "./storage";

export const TOKEN_KEY = "armada.token";

/** Tokens are opaque; reject only what can't possibly be one. */
export function isPlausibleToken(t: string): boolean {
  return t.length >= 8 && t.length <= 1024 && !/[\s#&]/.test(t);
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

export interface InitialToken {
  token: string | null;
  /** The token came from the pairing link just now (not from storage). */
  fresh: boolean;
  /** A pairing link was opened but its token was malformed. */
  invalidLink: boolean;
}

/**
 * Called once on load: adopt a token from the pairing link (and scrub it from
 * the address bar and history so it can't be shoulder-surfed or bookmarked),
 * otherwise fall back to the stored one.
 */
export function takeInitialToken(): InitialToken {
  const hash = location.hash;
  if (/(?:^#|[#&?/])token=/.test(hash)) {
    const token = tokenFromHash(hash);
    history.replaceState(null, "", `${location.pathname}${location.search}#/`);
    if (token) {
      storage.set(TOKEN_KEY, token);
      return { token, fresh: true, invalidLink: false };
    }
    return { token: storage.get(TOKEN_KEY), fresh: false, invalidLink: true };
  }
  return { token: storage.get(TOKEN_KEY), fresh: false, invalidLink: false };
}

export function storeToken(token: string) {
  storage.set(TOKEN_KEY, token);
}

export function clearToken() {
  storage.remove(TOKEN_KEY);
}

export type PastedPairing =
  | { kind: "token"; token: string }
  | { kind: "link"; url: string }
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
    const token = tokenFromHash(url.hash);
    if (!token) return { kind: "invalid" };
    if (url.origin === location.origin) return { kind: "token", token };
    return { kind: "link", url: url.href };
  }
  const fromFragment = text.includes("token=") ? tokenFromHash(text.startsWith("#") ? text : `#${text}`) : null;
  if (fromFragment) return { kind: "token", token: fromFragment };
  return isPlausibleToken(text) ? { kind: "token", token: text } : { kind: "invalid" };
}
