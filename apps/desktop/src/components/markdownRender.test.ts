import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { hasDefinitions, Markdown } from "./Markdown";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe("Markdown rendering", () => {
  it("resolves reference links and footnotes whose definitions sit in another block", () => {
    const out = html("See [the docs][1] and a note[^1].\n\n[1]: https://example.com/docs\n\n[^1]: The note.");
    expect(out).toContain('href="https://example.com/docs"');
    expect(out).not.toContain("[the docs][1]");
    expect(out).toContain("The note.");
  });

  it("only treats real definitions as such", () => {
    expect(hasDefinitions("a\n\n[1]: https://x.y")).toBe(true);
    expect(hasDefinitions("[^note]: text")).toBe(true);
    expect(hasDefinitions("- [x] done\n- [ ] todo")).toBe(false);
    expect(hasDefinitions("see [a]: not at the start of a line")).toBe(false);
  });

  it("lets each block pick its own direction, and keeps code left to right", () => {
    const out = html("مرحبا بالعالم\n\n```js\nconst a = 1;\n```");
    expect(out).toContain('dir="auto"');
    expect(out).toContain('dir="ltr"');
  });
});
