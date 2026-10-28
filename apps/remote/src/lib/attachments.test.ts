import { describe, expect, it } from "vitest";
import { attachError, base64Size, fitWithin, fromDataUrl, MAX_ATTACHMENTS, mergeAttachments, planEncode } from "./attachments";

describe("fitWithin", () => {
  it("keeps small images and scales large ones (1600px), preserving aspect ratio", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(4032, 3024)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(0, 10)).toEqual({ width: 0, height: 0 });
  });
});

describe("planEncode", () => {
  it("sends small PNG screenshots as-is (no JPEG blur on text)", () => {
    expect(planEncode("image/png", 400_000, 1170, 2532)).toMatchObject({ reencode: true }); // too tall
    expect(planEncode("image/png", 400_000, 1170, 1500)).toEqual({ reencode: false, width: 1170, height: 1500, mimeType: "image/png" });
  });
  it("always re-encodes JPEGs (strips EXIF/GPS, fixes orientation)", () => {
    expect(planEncode("image/jpeg", 80_000, 800, 600)).toEqual({ reencode: true, width: 800, height: 600, mimeType: "image/jpeg" });
    expect(planEncode("image/jpeg", 4_800_000, 4032, 3024)).toEqual({ reencode: true, width: 1600, height: 1200, mimeType: "image/jpeg" });
  });
  it("re-encodes odd formats as JPEG", () => {
    expect(planEncode("image/heic", 900_000, 1000, 800)).toMatchObject({ reencode: true, mimeType: "image/jpeg" });
  });
});

describe("inferMime", () => {
  it("uses the type, or the extension when the picker left it empty", async () => {
    const { inferMime } = await import("./attachments");
    expect(inferMime("x.png", "image/png")).toBe("image/png");
    expect(inferMime("IMG_0001.HEIC", "")).toBe("image/heic");
    expect(inferMime("photo.jpg", "")).toBe("image/jpeg");
    expect(inferMime("notes.txt", "")).toBe("");
  });
});

describe("helpers", () => {
  it("splits data URLs into the API shape", () => {
    expect(fromDataUrl("data:image/png;base64,AAAA")).toEqual({ mimeType: "image/png", data: "AAAA" });
    expect(fromDataUrl("blob:xyz")).toBeNull();
  });
  it("enforces the count and size limits", () => {
    const one = { data: "x".repeat(10) };
    expect(attachError([], one)).toBeNull();
    expect(attachError(Array.from({ length: MAX_ATTACHMENTS }, () => one), one)).toMatch(/up to 4/);
    expect(attachError([{ data: "x".repeat(19 * 1024 * 1024) }], { data: "x".repeat(2 * 1024 * 1024) })).toMatch(/too large/);
    expect(base64Size([one, one])).toBe(20);
  });
});

describe("mergeAttachments", () => {
  it("restores queued photos after the current ones, within the limit", () => {
    const a = (n: string) => ({ name: n, mimeType: "image/png", data: "AAAA" });
    expect(mergeAttachments([a("1")], [a("2"), a("3")])).toEqual({ list: [a("1"), a("2"), a("3")], dropped: 0 });
    const r = mergeAttachments([a("1"), a("2"), a("3")], [a("4"), a("5")]);
    expect(r.list.map((x) => x.name)).toEqual(["1", "2", "3", "4"]);
    expect(r.dropped).toBe(1);
  });
});
