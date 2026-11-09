// Pictures stored as files in the timeline carry only a file name; they are loaded once, when shown.
import { beforeEach, describe, expect, it, vi } from "vitest";

const readPicture = vi.fn();
vi.mock("@/lib/api", () => ({ api: { readPicture: (p: string) => readPicture(p) } }));
vi.mock("./api", () => ({ api: { readPicture: (p: string) => readPicture(p) } }));

const { cachedPicture, loadPicture } = await import("./pictures");
const { attachmentSrc } = await import("./attachments");

describe("stored pictures", () => {
  beforeEach(() => readPicture.mockReset());

  it("builds a data URL from inline bytes, and from a stored file once loaded", async () => {
    expect(attachmentSrc({ name: "a.png", mimeType: "image/png", data: "AAAA" })).toBe("data:image/png;base64,AAAA");
    readPicture.mockResolvedValue({ name: "p", mimeType: "image/png", data: "QUJD", path: "x.png" });
    expect(cachedPicture("x.png")).toBeUndefined();
    expect(await loadPicture("x.png")).toBe("data:image/png;base64,QUJD");
    expect(cachedPicture("x.png")).toBe("data:image/png;base64,QUJD");
  });

  it("reads each file once, even when asked twice at the same time", async () => {
    readPicture.mockResolvedValue({ name: "p", mimeType: "image/jpeg", data: "QUJD" });
    const [a, b] = await Promise.all([loadPicture("y.jpg"), loadPicture("y.jpg")]);
    expect(a).toBe(b);
    await loadPicture("y.jpg");
    expect(readPicture).toHaveBeenCalledTimes(1);
  });

  it("does not remember a failure", async () => {
    readPicture.mockRejectedValueOnce(new Error("gone"));
    await expect(loadPicture("z.png")).rejects.toThrow("gone");
    readPicture.mockResolvedValue({ name: "p", mimeType: "image/png", data: "QUJD" });
    expect(await loadPicture("z.png")).toContain("QUJD");
  });
});
