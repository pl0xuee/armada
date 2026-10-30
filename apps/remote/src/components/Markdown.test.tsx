import { describe, expect, it, vi } from "vitest";
import { renderToString } from "@/test/render";

// Hooks and memo are stubbed so components can be called directly (no DOM in these tests).
vi.mock("react", async (importOriginal) => {
  const m = await importOriginal<typeof import("react")>();
  return {
    ...m,
    memo: (c: unknown) => c,
    useMemo: (f: () => unknown) => f(),
    useState: (v: unknown) => [typeof v === "function" ? (v as () => unknown)() : v, () => {}],
    useRef: (v: unknown) => ({ current: v }),
    useEffect: () => {},
    useContext: () => null,
  };
});
vi.mock("./CopyButton", () => ({ CopyButton: () => null }));
vi.mock("./Icon", () => ({ Icon: () => null }));
vi.mock("./LocalImage", () => ({ LocalImage: ({ path, alt }: { path: string; alt?: string }) => <span data-local={path} data-alt={alt} /> }));

const { Markdown } = await import("./Markdown");
const html = (text: string, props: { caret?: boolean; interim?: boolean } = {}) => renderToString(<Markdown text={text} {...props} />);

describe("Markdown component", () => {
  it("renders every heading level with its own tag and a scale class (h4+ share one)", () => {
    const out = html("# a\n\n## b\n\n### c\n\n#### d\n\n###### e");
    expect(out).toContain('<h1 class="md-h md-h1">a</h1>');
    expect(out).toContain('<h2 class="md-h md-h2">b</h2>');
    expect(out).toContain('<h3 class="md-h md-h3">c</h3>');
    expect(out).toContain('<h4 class="md-h md-h4">d</h4>');
    expect(out).toContain('<h6 class="md-h md-h4">e</h6>');
  });

  it("renders setext headings and hard line breaks", () => {
    expect(html("Title\n=====")).toContain('<h1 class="md-h md-h1">Title</h1>');
    expect(html("a  \nb")).toContain("<p>a<br>b</p>");
    expect(html("a\\\nb")).toContain("<p>a<br>b</p>");
  });

  it("keeps tight list items free of paragraphs, loose ones not", () => {
    const tight = html("- one\n- two");
    expect(tight).toContain('<li><span class="block">one</span></li>');
    expect(tight).not.toContain("<p>");
    const loose = html("- one\n\n- two");
    expect(loose).toContain("<li><p>one</p></li>");
    // A list whose items are split by blank lines stays one list (and one numbering).
    expect(loose.match(/<ul/g)).toHaveLength(1);
    expect(html("1. a\n\n2. b\n\n3. c").match(/<ol/g)).toHaveLength(1);
  });

  it("puts task checkboxes at the start of the item", () => {
    const out = html("- [x] done\n- [ ] todo");
    expect(out).toContain('<ul class="md-ul md-tasks">');
    expect(out).toContain('<input class="md-check" type="checkbox" checked disabled aria-label="Done">done');
    expect(out).toContain('<input class="md-check" type="checkbox" disabled aria-label="Not done">todo');
  });

  it("labels code blocks like the desktop and keeps tabs", () => {
    expect(html("```rust,ignore\nfn a() {}\n```")).toContain(">rust</span>");
    expect(html("```\nx\n```")).toContain(">text</span>");
    expect(html("```go\n\tx := 1\n```")).toContain("<code>\tx := ");
  });

  it("colours +/- lines of diff blocks", () => {
    const out = html("```diff\n- old\n+ new\n@@ -1 +1 @@\n ctx\n```");
    expect(out).toMatch(/bg-\[var\(--diff-add\)] text-ok">\+ new/);
    expect(out).toMatch(/bg-\[var\(--diff-del\)] text-err">- old/);
    expect(out).toMatch(/text-accent\/80">@@/);
  });

  it("highlights known languages with class-only spans", () => {
    const out = html("```ts\nconst a = 'x'; // hi\n```");
    expect(out).toContain('<span class="tk-k">const</span>');
    expect(out).toContain('<span class="tk-s">\'x\'</span>');
    expect(out).toContain('<span class="tk-c">// hi</span>');
    expect(html("```weird\nconst a\n```")).not.toContain("tk-k");
  });

  it("shows local images through LocalImage and web images as a chip that is never an <img>", () => {
    expect(html("![shot](/tmp/shot.png)")).toContain('data-local="/tmp/shot.png"');
    expect(html("![shot](out/a%20b.png)")).toContain('data-local="out/a b.png"');
    expect(html("![s](file:///tmp/a%20b.png)")).toContain('data-local="/tmp/a b.png"');
    const web = html("![logo](https://example.com/x.png)");
    expect(web).not.toContain("<img");
    expect(web).toContain('<a class="md-imgchip" href="https://example.com/x.png"');
    expect(web).toContain("Image “logo”: example.com/x.png");
    expect(html("![d](data:image/png;base64,AAAA)")).toContain("unavailable");
    // Inside a link the chip must not be a second anchor.
    const nested = html("[![b](https://img.io/b.svg)](https://github.com/x)");
    expect(nested.match(/<a /g)).toHaveLength(1);
  });

  it("never renders raw HTML or unsafe links", () => {
    const out = html('<img src=x onerror="alert(1)"> [x](javascript:alert(1))');
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).not.toContain("javascript:");
    expect(out).toContain('<span class="md-badlink">x</span>');
  });

  it("wraps long table cells and aligns columns", () => {
    const out = html(`| a | b |\n|:-:|--:|\n| short | ${"long ".repeat(8)} |`);
    expect(out).toContain('<th style="textAlign:center">');
    expect(out).toContain('<td class="md-wrap" style="textAlign:right">');
    expect(out).toContain('<td style="textAlign:center">short</td>');
  });

  it("marks narration between tool calls as interim", () => {
    expect(html("hi", { interim: true })).toContain('class="md md-interim"');
    expect(html("hi")).toContain('class="md"');
  });
});
