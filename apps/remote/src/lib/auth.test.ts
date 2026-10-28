import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptValidatedToken,
  clearPairing,
  isPrivateHost,
  pairCodeFromHash,
  pairedToken,
  parsePasted,
  storedToken,
  takeLinkToken,
  tokenFromHash,
} from "./auth";

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
    expect(storedToken()).toEqual({
      token: "viewer-token-1",
      source: "shared",
    });
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
    expect(parsePasted("http://192.168.1.20:47821/#token=abcdefgh")).toEqual({
      kind: "token",
      token: "abcdefgh",
    });
    expect(parsePasted("http://10.0.0.5:47821/#token=abcdefgh")).toEqual({
      kind: "link",
      url: "http://10.0.0.5:47821/#token=abcdefgh",
      host: "10.0.0.5:47821",
      trusted: true,
    });
    expect(parsePasted("abcdefghijk")).toEqual({
      kind: "token",
      token: "abcdefghijk",
    });
    expect(parsePasted("not a token")).toEqual({ kind: "invalid" });
  });
});

const CODE = "0123456789abcdef0123456789abcdef";

describe("one-time pairing codes", () => {
  it("reads #pair= from a fragment", () => {
    expect(pairCodeFromHash(`#pair=${CODE}`)).toBe(CODE);
    expect(pairCodeFromHash("#pair=short")).toBeNull();
    expect(pairCodeFromHash("#/")).toBeNull();
  });

  it("consumes the code from the address bar and scrubs it", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("location", {
      origin: "http://192.168.1.20:47821",
      hash: `#pair=${CODE}`,
      pathname: "/",
      search: "",
    });
    vi.stubGlobal("history", { replaceState });
    expect(takeLinkToken()).toEqual({
      pairCode: CODE,
      candidate: null,
      malformed: false,
    });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/#/");
    vi.stubGlobal("location", {
      origin: "http://192.168.1.20:47821",
      hash: "#pair=nope",
      pathname: "/",
      search: "",
    });
    expect(takeLinkToken()).toEqual({
      pairCode: null,
      candidate: null,
      malformed: true,
    });
  });

  it("parses pasted pairing links and bare codes", () => {
    expect(parsePasted(`http://192.168.1.20:47821/#pair=${CODE}`)).toEqual({
      kind: "pair",
      code: CODE,
    });
    expect(parsePasted(CODE)).toEqual({ kind: "pair", code: CODE });
    expect(parsePasted(`#pair=${CODE}`)).toEqual({ kind: "pair", code: CODE });
    // A long token is not mistaken for a pairing code.
    expect(parsePasted(CODE + CODE)).toEqual({
      kind: "token",
      token: CODE + CODE,
    });
  });

  it("only follows links to private addresses without asking", () => {
    const link = (u: string) => parsePasted(`${u}/#pair=${CODE}`);
    expect(link("http://192.168.1.99:47821")).toMatchObject({
      kind: "link",
      trusted: true,
    });
    expect(link("http://100.101.2.3:47821")).toMatchObject({
      kind: "link",
      trusted: true,
    });
    expect(link("http://[fd12::1]:47821")).toMatchObject({
      kind: "link",
      trusted: true,
    });
    expect(link("http://evil.example.com")).toMatchObject({
      kind: "link",
      trusted: false,
      host: "evil.example.com",
    });
    expect(link("http://8.8.8.8:47821")).toMatchObject({
      kind: "link",
      trusted: false,
    });
  });
});

describe("isPrivateHost", () => {
  it("accepts loopback and private ranges only", () => {
    for (const h of [
      "localhost",
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.9.9",
      "192.168.0.5",
      "169.254.1.1",
      "100.64.0.1",
      "100.127.1.1",
      "[::1]",
      "fc00::1",
      "fe80::1",
    ]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of [
      "172.32.0.1",
      "100.63.0.1",
      "100.128.0.1",
      "8.8.8.8",
      "300.1.1.1",
      "armada.example.com",
      "192.168.1.1.evil.com",
      "2606:4700::1111",
    ]) {
      expect(isPrivateHost(h), h).toBe(false);
    }
  });
});
