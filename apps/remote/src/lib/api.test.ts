import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, pairDevice, SseParser } from "./api";

describe("SseParser", () => {
  it("handles chunk boundaries, CRLF, comments and multi-line data", () => {
    const got: string[] = [];
    const p = new SseParser((d) => got.push(d));
    p.push(": heartbeat\n\nda");
    p.push('ta: {"type":"resync"}\r');
    p.push("\n\r\ndata: a\ndata: b\n\n: ping\n\ndata:no-space\n\n");
    expect(got).toEqual(['{"type":"resync"}', "a\nb", "no-space"]);
  });
  it("ignores event/id fields and incomplete trailing events", () => {
    const got: string[] = [];
    const p = new SseParser((d) => got.push(d));
    p.push("event: x\nid: 7\ndata: 1\n\ndata: partial");
    expect(got).toEqual(["1"]);
  });
});

describe("pairDevice", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the code without credentials and returns the device token", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ token: "t".repeat(64), scope: "owner" }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(pairDevice("c".repeat(32), "iPhone")).resolves.toEqual({
      token: "t".repeat(64),
      scope: "owner",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/pair");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    expect(JSON.parse(init.body as string)).toEqual({
      code: "c".repeat(32),
      deviceName: "iPhone",
    });
    expect(
      (init.headers as Record<string, string>).Authorization,
    ).toBeUndefined();
  });

  it("reports a refused or expired code as unauthorized, and a rate limit as such", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            error: "That pairing code didn't work or has expired.",
          }),
          { status: 401 },
        ),
    );
    const err = await pairDevice("c".repeat(32), "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).isUnauthorized).toBe(true);
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 429 }));
    expect(
      (
        (await pairDevice("c".repeat(32), "x").catch(
          (e: unknown) => e,
        )) as ApiError
      ).isRateLimited,
    ).toBe(true);
  });

  it("maps a network failure to a status-0 error", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    expect(
      (
        (await pairDevice("c".repeat(32), "x").catch(
          (e: unknown) => e,
        )) as ApiError
      ).isNetwork,
    ).toBe(true);
  });
});
