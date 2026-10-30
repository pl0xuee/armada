import { describe, expect, it } from "vitest";
import { inlineImageSrc, MAX_INLINE_IMAGE_CHARS } from "./inlineImage";

describe("inlineImageSrc", () => {
  it("accepts small raster data URIs", () => {
    expect(inlineImageSrc("data:image/png;base64,iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(inlineImageSrc(" data:image/jpeg;base64,/9j/4AAQ ")).toBe("data:image/jpeg;base64,/9j/4AAQ");
  });
  it("refuses everything else", () => {
    expect(inlineImageSrc("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
    expect(inlineImageSrc("data:text/html;base64,PGI+")).toBeNull();
    expect(inlineImageSrc("data:image/png;base64,abc def")).toBeNull();
    expect(inlineImageSrc("https://example.com/a.png")).toBeNull();
    expect(inlineImageSrc("data:image/png;base64," + "A".repeat(MAX_INLINE_IMAGE_CHARS))).toBeNull();
  });
});
