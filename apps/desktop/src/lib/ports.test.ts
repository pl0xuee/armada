import { describe, expect, it } from "vitest";
import { detectDevUrls, effectiveLoopbackUrl, parseLoopbackUrl, rankDevUrls, urlPort } from "./ports";

describe("detectDevUrls", () => {
  it("reads vite output with ANSI codes", () => {
    const t = "  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n";
    expect(detectDevUrls(t)).toEqual([{ url: "http://localhost:5173/", port: 5173 }]);
  });
  it("maps 0.0.0.0 and [::1] to localhost and dedupes by port", () => {
    const t = "listening on 0.0.0.0:3000\nhttp://0.0.0.0:3000/\nhttp://[::1]:8000/app";
    expect(detectDevUrls(t)).toEqual([
      { url: "http://localhost:3000/", port: 3000 },
      { url: "http://localhost:8000/app", port: 8000 },
    ]);
  });
  it("ignores non-loopback hosts and bad ports", () => {
    expect(detectDevUrls("http://example.com:3000 http://192.168.1.2:3000 http://localhost:99999")).toEqual([]);
  });
});

describe("parseLoopbackUrl", () => {
  it("accepts loopback http(s)", () => {
    expect(parseLoopbackUrl("localhost:3000")).toBe("http://localhost:3000/");
    expect(parseLoopbackUrl("https://127.0.0.1:8443/x")).toBe("https://127.0.0.1:8443/x");
    expect(parseLoopbackUrl("http://[::1]:80/")).toBe("http://[::1]/");
  });
  it("rejects everything else", () => {
    for (const s of [
      "",
      "http://example.com",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "http://localhost@evil.com",
      "http://localhost.evil.com",
    ]) {
      expect(parseLoopbackUrl(s)).toBeNull();
    }
  });
  it("urlPort", () => {
    expect(urlPort("http://localhost:3000/")).toBe(3000);
    expect(urlPort("http://localhost/")).toBe(80);
  });
});

describe("rankDevUrls", () => {
  it("puts the most recently mentioned server last", () => {
    const t =
      "The dev server for this branch is running at http://127.0.0.1:4323 (4321 was already taken)\nearlier: http://127.0.0.1:4321/";
    expect(rankDevUrls(t).map((d) => d.port)).toEqual([4323, 4321]);
    expect(rankDevUrls(`${t}\nnow http://localhost:4323/`).map((d) => d.port)).toEqual([4321, 4323]);
  });
  it("keeps one entry per port and a path from an earlier mention over a bare later one", () => {
    const r = rankDevUrls("see http://localhost:3000/docs then http://localhost:3000");
    expect(r).toEqual([{ url: "http://localhost:3000/docs", port: 3000 }]);
  });
  it("is empty without loopback URLs", () => {
    expect(rankDevUrls("nothing here, http://example.com:80")).toEqual([]);
  });
});

describe("effectiveLoopbackUrl", () => {
  const v4 = { v4: true, v6: false };
  const v6 = { v4: false, v6: true };
  it("keeps a 127.0.0.1 URL while IPv4 listens", () => {
    expect(effectiveLoopbackUrl("http://127.0.0.1:4321/a", v4)).toBe("http://127.0.0.1:4321/a");
  });
  it("switches to localhost when only ::1 listens or the URL is [::1]", () => {
    expect(effectiveLoopbackUrl("http://127.0.0.1:4321/a", v6)).toBe("http://localhost:4321/a");
    expect(effectiveLoopbackUrl("http://[::1]:4321/", v6)).toBe("http://localhost:4321/");
  });
  it("leaves localhost alone and reports nothing listening as null", () => {
    expect(effectiveLoopbackUrl("http://localhost:3000/", v4)).toBe("http://localhost:3000/");
    expect(effectiveLoopbackUrl("http://localhost:3000/", { v4: false, v6: false })).toBeNull();
  });
});
