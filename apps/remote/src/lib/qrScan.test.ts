import { afterEach, describe, expect, it, vi } from "vitest";
import { canScanQr, scanUnavailableReason, scannedPairCode } from "./qrScan";

const CODE = "0123456789abcdef0123456789abcdef";

describe("scanning a pairing QR code", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("takes the pairing code from a link to any address of the computer", () => {
    expect(scannedPairCode(`http://192.168.1.20:47821/#pair=${CODE}`)).toBe(
      CODE,
    );
    expect(scannedPairCode(` https://box.tail1234.ts.net/#pair=${CODE} `)).toBe(
      CODE,
    );
    // Not a pairing link: left to the paste rules (share tokens, other text).
    expect(scannedPairCode("https://example.com/#token=abcdefgh")).toBeNull();
    expect(scannedPairCode(`javascript:alert(1)//#pair=${CODE}`)).toBeNull();
    expect(scannedPairCode("hello")).toBeNull();
    expect(scannedPairCode(`http://x/#pair=short`)).toBeNull();
  });

  it("offers the camera only on a secure address", () => {
    vi.stubGlobal("window", { isSecureContext: false });
    expect(canScanQr()).toBe(false);
    expect(scanUnavailableReason()).toBe("insecure");
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: { getUserMedia: () => Promise.resolve() },
    });
    expect(canScanQr()).toBe(true);
    expect(scanUnavailableReason()).toBeNull();
  });
});
