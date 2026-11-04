import { describe, expect, it } from "vitest";
import { MAX_INLINE_IMAGE_CHARS } from "@shared/inlineImage";
import { MAX_FORMATTED, parseBlocks, parseInline } from "./markdown";

/** A data URI with `n` characters of (fake) base64. */
const data = (n: number, mime = "png") => `data:image/${mime};base64,` + "QUJD".repeat(Math.ceil(n / 4)).slice(0, n);

describe("inline data pictures", () => {
  it("finds a picture far longer than the link pattern looks ahead", () => {
    // The real test picture an agent sent: a 3 KB WebP is 4,300 characters of base64.
    const src = data(4_312, "webp");
    expect(parseInline(`![Fens stilt market, test](${src})`)).toEqual([{ t: "image", src, alt: "Fens stilt market, test" }]);
    expect(parseInline(`Before ![a \\[b\\]](${src}) after`)).toEqual(["Before ", { t: "image", src, alt: "a [b]" }, " after"]);
  });

  it("keeps formatting a reply whose length is mostly a picture", () => {
    const src = data(MAX_FORMATTED * 30);
    const blocks = parseBlocks(`**Title screen**\n![Title](${src})\n\nDone.`);
    expect(blocks).toEqual([
      { t: "p", text: `**Title screen**\n![Title](${src})`, plain: undefined },
      { t: "p", text: "Done.", plain: undefined },
    ]);
    const inline = parseInline((blocks[0] as { text: string }).text);
    expect(inline[0]).toEqual({ t: "strong", children: ["Title screen"] });
    expect(inline[inline.length - 1]).toEqual({ t: "image", src, alt: "Title" });
  });

  it("still shows over-long text and over-large or broken pictures as text", () => {
    expect(parseBlocks("x".repeat(MAX_FORMATTED + 1))[0]).toMatchObject({ plain: true });
    const big = data(MAX_INLINE_IMAGE_CHARS);
    expect(parseInline(`![big](${big})`).some((n) => typeof n !== "string" && n.t === "image")).toBe(false);
    const cut = `![cut](${data(5_000)}`; // never closed
    expect(parseInline(cut)).toEqual([cut]);
    const spaced = `![sp](${data(3_000)} AAAA)`; // a space inside the data
    expect(parseInline(spaced).some((n) => typeof n !== "string" && n.t === "image")).toBe(false);
  });

  it("stays fast on many unfinished pictures", () => {
    const text = `![a](${data(40)} `.repeat(200);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) parseInline(text + i);
    expect(performance.now() - t0).toBeLessThan(250);
  });
});
