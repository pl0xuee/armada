import { beforeEach, describe, expect, it, vi } from "vitest";

const pairDevice = vi.fn();
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  pairDevice: (...a: unknown[]) => pairDevice(...a),
}));

import type { ApiError as ApiErrorT } from "./api";

let ApiError: typeof ApiErrorT;
let pairWithCode: (c: string) => Promise<void>;
let retryConnect: () => Promise<void>;
let getState: typeof import("./store").getState;

beforeEach(async () => {
  vi.stubGlobal("location", { hash: "", search: "", pathname: "/", href: "http://x/", origin: "http://x", assign() {}, replace() {} });
  vi.stubGlobal("window", Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" });
  vi.stubGlobal("history", { replaceState() {}, pushState() {} });
  vi.resetModules();
  ({ ApiError } = await import("./api"));
  ({ pairWithCode, retryConnect } = await import("./controller"));
  ({ getState } = await import("./store"));
  localStorage.clear();
  pairDevice.mockReset();
});

describe("pairing retries", () => {
  it("shows the server's message when the device list is full", async () => {
    pairDevice.mockRejectedValue(
      new ApiError(409, "Too many paired devices. Remove one in Armada first."),
    );
    await pairWithCode("code-409");
    expect(getState().phase).toBe("blocked");
    expect(getState().blockedMessage).toBe(
      "Too many paired devices. Remove one in Armada first.",
    );
  });

  it("Try again after a network failure reuses the same code", async () => {
    pairDevice.mockRejectedValueOnce(new ApiError(0, null));
    await pairWithCode("code-net");
    expect(getState().blockedReason).toBe("unreachable");
    pairDevice.mockRejectedValueOnce(new ApiError(429, "Slow down."));
    await retryConnect();
    expect(pairDevice).toHaveBeenLastCalledWith("code-net", expect.any(String));
    expect(getState().blockedReason).toBe("rate_limited");
  });
});
