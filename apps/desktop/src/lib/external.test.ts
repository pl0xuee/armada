import { describe, expect, it } from "vitest";
import { linkMismatchHost } from "./external";

describe("linkMismatchHost", () => {
  it("flags text that names a different host", () => {
    expect(linkMismatchHost("github.com/foo/bar", "https://evil.example/x")).toBe("evil.example");
    expect(linkMismatchHost("https://github.com", "http://github.com.evil.io/")).toBe("github.com.evil.io");
  });
  it("accepts matching hosts, ignoring www and case", () => {
    expect(linkMismatchHost("https://GitHub.com/a", "https://github.com/b")).toBeNull();
    expect(linkMismatchHost("www.example.com", "https://example.com/")).toBeNull();
  });
  it("ignores ordinary link text", () => {
    expect(linkMismatchHost("the docs", "https://evil.example")).toBeNull();
    expect(linkMismatchHost("click here now.", "https://evil.example")).toBeNull();
    expect(linkMismatchHost("example.com", undefined)).toBeNull();
    expect(linkMismatchHost("example.com", "not a url")).toBeNull();
  });
});
