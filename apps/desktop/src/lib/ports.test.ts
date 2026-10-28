import { describe, expect, it } from "vitest";
import { detectDevUrls, parseLoopbackUrl, urlPort } from "./ports";

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
