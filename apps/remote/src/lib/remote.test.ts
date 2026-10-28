import { describe, expect, it } from "vitest";
import { ApiError, describeStatus, newIdempotencyKey, retryDelay } from "./api";
import { isPlausibleToken } from "./auth";
import { linkHostHint, parseInline } from "./markdown";
import { isLocalImagePath, loadLocalImage, cachedLocalImage } from "./localImages";
import { parseFileDiff, MAX_DIFF_INPUT } from "./diff";
import { filterAgents } from "./selectors";
import type { Agent } from "./types";

describe("errors", () => {
  it("shows the server's text for 408/413/429/503 and translates 421", () => {
    expect(describeStatus(413, "That request is too large.")).toBe("That request is too large.");
    expect(describeStatus(408, "The upload took too long.")).toBe("The upload took too long.");
    expect(describeStatus(429, "Too many open connections for this device or link.")).toMatch(/Too many open connections/);
    expect(describeStatus(503, "Remote access was turned off.")).toBe("Remote access was turned off.");
    expect(describeStatus(421, "Unexpected host.")).toMatch(/QR code or the LAN address/);
    expect(describeStatus(400, "Armada is shutting down")).toMatch(/shutting down on your computer/);
  });
});

describe("idempotency", () => {
  it("makes RFC 4122 v4 keys without crypto.randomUUID", () => {
    const k = newIdempotencyKey();
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newIdempotencyKey()).not.toBe(k);
  });
  it("retries lost connections and in-flight duplicates, nothing else", () => {
    expect(retryDelay(new ApiError(0, null), 0)).toBeGreaterThan(0);
    expect(retryDelay(new ApiError(0, null), 2)).toBeNull();
    expect(retryDelay(new ApiError(409, "That request is still being processed."), 5)).toBe(2_000);
    expect(retryDelay(new ApiError(409, "Something else"), 0)).toBeNull();
    expect(retryDelay(new ApiError(408, "The upload took too long."), 0)).toBeNull(); // server deadline: don't resend
    expect(retryDelay(new ApiError(400, "bad"), 0)).toBeNull();
    expect(retryDelay(new Error("x"), 0)).toBeNull();
  });
});

describe("tokens", () => {
  it("accepts only URL-safe/base64 characters", () => {
    expect(isPlausibleToken("abcDEF012-_.~+/=")).toBe(true);
    expect(isPlausibleToken("short")).toBe(false);
    expect(isPlausibleToken("has space in it")).toBe(false);
    expect(isPlausibleToken("quote\"or<tag>")).toBe(false);
  });
});

describe("links and local images", () => {
  it("shows the host when the label hides it", () => {
    expect(linkHostHint("https://evil.example.com/login", "your bank")).toBe("evil.example.com");
    expect(linkHostHint("https://www.example.com/x", "example.com docs")).toBeNull();
    expect(linkHostHint("mailto:a@b.c", "mail")).toBeNull();
  });
  it("recognises local image paths in markdown image syntax", () => {
    const [n] = parseInline("![shot](/tmp/shot.png)");
    expect(n).toMatchObject({ t: "link", href: null, raw: "/tmp/shot.png", image: true });
    expect(isLocalImagePath("/tmp/shot.png")).toBe(true);
    expect(isLocalImagePath("C:\\\\shots\\\\a.JPG")).toBe(true);
    expect(isLocalImagePath("relative/a.png")).toBe(false);
    expect(isLocalImagePath("/etc/passwd")).toBe(false);
  });
  it("fetches each image once and caches it", async () => {
    let calls = 0;
    const fetcher = async () => (calls++, { name: "a.png", mimeType: "image/png", data: "AAAA" });
    const [a, b] = await Promise.all([loadLocalImage("ag", "/p/a.png", fetcher), loadLocalImage("ag", "/p/a.png", fetcher)]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    expect(cachedLocalImage("ag", "/p/a.png")).toBe(a);
  });
});

describe("big diffs", () => {
  it("skips the line diff on huge inputs", () => {
    const big = "x\n".repeat(MAX_DIFF_INPUT / 2 + 10);
    const [d] = parseFileDiff({ path: "big.txt", oldText: big, newText: big + "y\n", unified: null });
    expect(d.tooLarge).toBe(true);
    expect(d.lines).toEqual([]);
  });
});

describe("fleet search", () => {
  it("matches title, project, branch and last message", () => {
    const a = (id: string, extra: Partial<Agent>) => ({ id, title: id, lastMessage: null, branch: null, projectPath: "/x", ...extra }) as Agent;
    const list = [a("Fix auth", {}), a("b", { projectPath: "/code/billing" }), a("c", { branch: "armada/auth-fix" }), a("d", { lastMessage: "tests pass" })];
    expect(filterAgents(list, "auth").map((x) => x.id)).toEqual(["Fix auth", "c"]);
    expect(filterAgents(list, "BILLING").map((x) => x.id)).toEqual(["b"]);
    expect(filterAgents(list, "  ").length).toBe(4);
  });
});
