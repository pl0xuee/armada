import { beforeEach, describe, expect, it, vi } from "vitest";
import { adoptValidatedToken, clearPairing, pairedToken, parsePasted, storedToken, tokenFromHash } from "./auth";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("location", { origin: "http://192.168.1.20:47821" });
});

describe("tokenFromHash", () => {
  it("keeps base64 characters intact", () => {
    expect(tokenFromHash("#token=ab+cd/ef==")).toBe("ab+cd/ef==");
    expect(tokenFromHash("#/agent/x?token=abcdefgh&y=1")).toBe("abcdefgh");
    expect(tokenFromHash("#token=short")).toBeNull();
    expect(tokenFromHash("#/")).toBeNull();
  });
});

describe("pairing storage", () => {
  it("keeps the owner pairing when a share link is opened (tab-only)", () => {
    expect(adoptValidatedToken("owner-token-1", "owner")).toBe("stored");
    expect(adoptValidatedToken("viewer-token-1", "viewer")).toBe("shared");
    expect(pairedToken()).toEqual({ token: "owner-token-1", scope: "owner" });
    expect(storedToken()).toEqual({ token: "viewer-token-1", source: "shared" });
  });

  it("stores a share link when the device has no owner pairing", () => {
    expect(adoptValidatedToken("viewer-token-1", "viewer")).toBe("stored");
    expect(adoptValidatedToken("viewer-token-2", "viewer")).toBe("stored");
    expect(pairedToken()).toEqual({ token: "viewer-token-2", scope: "viewer" });
  });

  it("only clears the pairing it was asked to clear", () => {
    adoptValidatedToken("owner-token-2", "owner");
    clearPairing("some-other-token");
    expect(pairedToken()?.token).toBe("owner-token-2");
    clearPairing("owner-token-2");
    expect(pairedToken()).toBeNull();
  });
});

describe("parsePasted", () => {
  it("accepts links for this origin, other origins and raw tokens", () => {
    expect(parsePasted("http://192.168.1.20:47821/#token=abcdefgh")).toEqual({ kind: "token", token: "abcdefgh" });
    expect(parsePasted("http://10.0.0.5:47821/#token=abcdefgh")).toEqual({ kind: "link", url: "http://10.0.0.5:47821/#token=abcdefgh" });
    expect(parsePasted("abcdefghijk")).toEqual({ kind: "token", token: "abcdefghijk" });
    expect(parsePasted("not a token")).toEqual({ kind: "invalid" });
  });
});
