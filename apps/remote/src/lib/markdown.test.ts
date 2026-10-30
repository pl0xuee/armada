import { describe, expect, it } from "vitest";
import { CARET, MAX_FORMATTED, parseBlocks, parseInline, safeHref, type Inline } from "./markdown";

const text = (nodes: Inline[]): string =>
  nodes.map((n) => (typeof n === "string" ? n : "children" in n ? text(n.children) : n.t === "code" ? n.text : "")).join("");

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

describe("blocks", () => {
  it("parses headings, including closing hashes", () => {
    expect(parseBlocks("## Title ##")).toEqual([{ t: "h", level: 2, text: "Title" }]);
    expect(parseBlocks("# C# rocks")).toEqual([{ t: "h", level: 1, text: "C# rocks" }]);
    expect(parseBlocks("#hashtag")[0]).toMatchObject({ t: "p" });
    expect(parseBlocks("###")).toEqual([{ t: "h", level: 3, text: "" }]);
  });

  it("parses fences, including unterminated ones while streaming", () => {
    expect(parseBlocks("```ts\nconst a = 1;\n```\nafter")).toEqual([
      { t: "code", lang: "ts", text: "const a = 1;" },
      { t: "p", text: "after" },
    ]);
    expect(parseBlocks("~~~\nopen <i>")).toEqual([{ t: "code", lang: "", text: "open <i>" }]);
    // A longer closing run still closes; a shorter one doesn't.
    expect(parseBlocks("````\na\n```\n````")[0]).toEqual({ t: "code", lang: "", text: "a\n```" });
  });

  it("parses lists, nesting, quotes, rules and tables", () => {
    const b = parseBlocks("- a\n  - b\n- c\n\n1. one\n2. two\n\n> q\n\n---\n\n| x | y |\n|:-|-:|\n| 1 | 2 |");
    expect(b.map((x) => x.t)).toEqual(["list", "list", "quote", "hr", "table"]);
    expect(b[0]).toMatchObject({ t: "list", ordered: false, items: [[{ t: "p" }, { t: "list" }], [{ t: "p" }]] });
    expect(b[4]).toMatchObject({ t: "table", head: ["x", "y"], align: ["left", "right"], rows: [["1", "2"]] });
  });

  it("separates a paragraph that follows a list", () => {
    expect(parseBlocks("- a\n- b\n\nRun it").map((x) => x.t)).toEqual(["list", "p"]);
  });

  it("renders over-long lines as plain text", () => {
    const long = "*".repeat(MAX_FORMATTED + 1);
    expect(parseBlocks(long)).toEqual([{ t: "p", text: long, plain: true }]);
  });
});

describe("inline", () => {
  it("handles emphasis, code, links and escapes", () => {
    expect(parseInline("**b** *i* ~~s~~ `c`")).toEqual([
      { t: "strong", children: ["b"] },
      " ",
      { t: "em", children: ["i"] },
      " ",
      { t: "del", children: ["s"] },
      " ",
      { t: "code", text: "c" },
    ]);
    expect(parseInline("\\*not em\\*")).toEqual(["*not em*"]);
    expect(parseInline("snake_case_name")).toEqual(["snake_case_name"]);
  });

  it("only links safe URLs", () => {
    expect(parseInline("[x](javascript:alert(1))")).toMatchObject([{ t: "link", href: null, children: ["x"] }]);
    expect(parseInline("[w](https://en.wikipedia.org/wiki/A_(b))")).toMatchObject([
      { t: "link", href: "https://en.wikipedia.org/wiki/A_(b)", children: ["w"] },
    ]);
    expect(parseInline("see https://ex.com/path.")).toEqual([
      "see ",
      { t: "link", href: "https://ex.com/path", children: ["https://ex.com/path"] },
      ".",
    ]);
    expect(safeHref("data:text/html,<script>")).toBeNull();
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
  });

  it("keeps raw HTML as text", () => {
    expect(text(parseInline('<img src=x onerror="alert(1)"> <b>x</b>'))).toBe('<img src=x onerror="alert(1)"> <b>x</b>');
  });

  it("renders the streaming caret where the text ends", () => {
    expect(parseInline(`a **b${CARET}`)).toEqual(["a **b", { t: "caret" }]);
  });

  it("matches code spans by exact backtick-run length", () => {
    expect(parseInline("``a ` b``")).toEqual([{ t: "code", text: "a ` b" }]);
    expect(parseInline("` unclosed")).toEqual(["` unclosed"]);
  });
});

describe("adversarial input stays fast", () => {
  // Each of these was quadratic or worse with the previous regexes.
  const cases: [string, string][] = [
    ["heading + whitespace run", `#${" ".repeat(60_000)}x`],
    ["heading + whitespace, no end", `# a${" \t".repeat(30_000)}#x`],
    ["unclosed strong", "** a ".repeat(2_000)],
    ["unclosed em", "*a ".repeat(3_300)],
    ["unclosed strike", "~~a ".repeat(2_500)],
    ["unclosed links", "[a](".repeat(2_500)],
    ["nested brackets", "[".repeat(9_000)],
    ["backtick runs", "` `` ``` ".repeat(1_000)],
    ["table separator whitespace", `|${" ".repeat(50_000)}x\n|${" ".repeat(50_000)}-x`],
    ["fence info whitespace", `\`\`\`${" ".repeat(50_000)}\``],
    ["rule-like whitespace", `- ${" ".repeat(50_000)}-${" ".repeat(50_000)}x`],
    ["list marker whitespace", `-${" ".repeat(50_000)}`],
    ["many lines", "a\n".repeat(50_000)],
  ];
  for (const [name, input] of cases) {
    it(name, () => {
      const { ms } = timed(() => {
        for (const b of parseBlocks(input)) if (b.t === "p" || b.t === "h") parseInline(b.text);
      });
      expect(ms).toBeLessThan(400);
    });
  }
});

describe("segments and caching", () => {
  it("splits at blank lines but keeps fences and indented continuations together", async () => {
    const { splitSegments } = await import("./markdown");
    const text = "Para one\n\n```js\na\n\nb\n```\n\n- item\n\n  continued\n- next\n\nEnd";
    expect(splitSegments(text)).toEqual(["Para one", "```js\na\n\nb\n```", "- item\n\n  continued\n- next", "End"]);
    expect(splitSegments("")).toEqual([""]);
  });
  it("parses each segment the same as the whole for ordinary messages", async () => {
    const { splitSegments, parseBlocks } = await import("./markdown");
    const text = "# T\n\nSome **bold**.\n\n```ts\nx\n```\n\n| a | b |\n|-|-|\n| 1 | 2 |";
    expect(splitSegments(text).flatMap((s) => parseBlocks(s))).toEqual(parseBlocks(text));
  });
  it("keeps a bounded LRU", async () => {
    const { LruCache } = await import("./markdown");
    const c = new LruCache<number>(2);
    c.set("a", 1);
    c.set("b", 2);
    c.get("a");
    c.set("c", 3);
    expect([c.get("a"), c.get("b"), c.get("c"), c.size]).toEqual([1, undefined, 3, 2]);
  });
  it("caches parses but never the streaming (caret) text", async () => {
    const { parseBlocksCached } = await import("./markdown");
    const a = parseBlocksCached("same text");
    expect(parseBlocksCached("same text")).toBe(a);
    const s = `streaming${CARET}`;
    expect(parseBlocksCached(s)).not.toBe(parseBlocksCached(s));
  });
});

describe("block structure (matches the desktop's CommonMark + GFM)", () => {
  it("parses setext headings, also over several lines", () => {
    expect(parseBlocks("Title\n=====\n\nSub\n---\n\nafter")).toEqual([
      { t: "h", level: 1, text: "Title" },
      { t: "h", level: 2, text: "Sub" },
      { t: "p", text: "after" },
    ]);
    expect(parseBlocks("line a\nline b\n===")).toEqual([{ t: "h", level: 1, text: "line a line b" }]);
    // Without a paragraph above, dashes are still a rule.
    expect(parseBlocks("---")).toEqual([{ t: "hr" }]);
    expect(parseBlocks("a\n\n---\n\nb").map((b) => b.t)).toEqual(["p", "hr", "p"]);
  });

  it("keeps trailing double spaces for hard line breaks", () => {
    expect(parseBlocks("one  \ntwo   ")).toEqual([{ t: "p", text: "one  \ntwo" }]);
    expect(parseInline("one  \ntwo")).toEqual(["one", { t: "br" }, "two"]);
    expect(parseInline("one\\\ntwo")).toEqual(["one", { t: "br" }, "two"]);
    expect(parseInline("one\ntwo")).toEqual(["one two"]);
  });

  it("marks a list loose only when blank lines separate items or an item's blocks", () => {
    const loose = (s: string) => (parseBlocks(s)[0] as { loose: boolean }).loose;
    expect(loose("- a\n- b")).toBe(false);
    expect(loose("- a\n\n- b")).toBe(true);
    expect(loose("- a\n\n  more\n- b")).toBe(true);
    // A tight item with a fenced block (even one containing a blank line) stays tight.
    expect(loose("- a\n  ```\n  x\n\n  y\n  ```\n- b")).toBe(false);
    expect(parseBlocks("1. a\n\n2. b\n\n3. c")).toHaveLength(1);
  });

  it("starts a new list when the bullet character changes", () => {
    expect(parseBlocks("- a\n* b\n+ c").map((b) => b.t)).toEqual(["list", "list", "list"]);
    expect(parseBlocks("1. a\n1) b").map((b) => b.t)).toEqual(["list", "list"]);
  });

  it("reads GFM task items and strips the marker", () => {
    const [list] = parseBlocks("- [x] done\n- [ ] todo\n- [X] Done\n- plain\n- [x]nope");
    expect(list).toMatchObject({ t: "list", checked: [true, false, true, null, null] });
    const items = (list as { items: unknown[][] }).items;
    expect(items[0]).toEqual([{ t: "p", text: "done" }]);
    expect(items[4]).toEqual([{ t: "p", text: "[x]nope" }]);
    expect(parseBlocks("- a\n- b")[0]).not.toHaveProperty("checked");
    expect(parseBlocks("1. [x] one")[0]).toMatchObject({ ordered: true, checked: [true] });
  });

  it("keeps tabs inside fenced code, but expands leading tabs for nesting", () => {
    expect(parseBlocks("```go\nfunc a() {\n\tx()\n}\n```")).toEqual([{ t: "code", lang: "go", text: "func a() {\n\tx()\n}" }]);
    expect(parseBlocks("- a\n\t- b")[0]).toMatchObject({ items: [[{ t: "p" }, { t: "list" }]] });
  });

  it("parses indented code blocks, but not an indented line inside a paragraph", () => {
    expect(parseBlocks("para\n\n    code a\n\n    code b\n\nafter")).toEqual([
      { t: "p", text: "para" },
      { t: "code", lang: "", text: "code a\n\ncode b" },
      { t: "p", text: "after" },
    ]);
    expect(parseBlocks("para\n    still para")).toEqual([{ t: "p", text: "para\nstill para" }]);
  });

  it("only lets '1.' lists, bullets and non-empty items interrupt a paragraph", () => {
    expect(parseBlocks("text\n2. not a list").map((b) => b.t)).toEqual(["p"]);
    expect(parseBlocks("text\n1. a\n2. b").map((b) => b.t)).toEqual(["p", "list"]);
    expect(parseBlocks("Summary:\n- a").map((b) => b.t)).toEqual(["p", "list"]);
  });

  it("keeps a list together across blank lines when splitting into segments", async () => {
    const { splitSegments } = await import("./markdown");
    expect(splitSegments("1. one\n\n2. two\n\n3. three\n\nafter")).toEqual(["1. one\n\n2. two\n\n3. three", "after"]);
    expect(splitSegments("- a\n\n  b\n\n- c\n\n\n\npara")).toEqual(["- a\n\n  b\n\n- c", "para"]);
    // The whole message and its segments agree.
    const text = "- a\n\n- b\n\nSome text\n\n1. x\n\n2. y";
    expect(splitSegments(text).flatMap((s) => parseBlocks(s))).toEqual(parseBlocks(text));
  });
});

describe("inline (matches the desktop)", () => {
  it("handles nested emphasis, single-tilde strike and any escapable punctuation", () => {
    expect(parseInline("***both***")).toEqual([{ t: "em", children: [{ t: "strong", children: ["both"] }] }]);
    expect(parseInline("~one~ and ~~two~~")).toEqual([{ t: "del", children: ["one"] }, " and ", { t: "del", children: ["two"] }]);
    expect(parseInline("takes ~5 min, ~10 min")).toEqual(["takes ~5 min, ~10 min"]);
    expect(parseInline("see ~/a and ~/b")).toEqual(["see ~/a and ~/b"]);
    expect(parseInline("\\$5 \\& \\@ \\/ \\: \\<b\\>")).toEqual(["$5 & @ / : <b>"]);
  });

  it("decodes character references, but only valid ones", () => {
    expect(parseInline("a &amp; b &lt;t&gt; &copy; &#35; &#x1F680; &nbsp;")).toEqual(["a & b <t> © # 🚀  "]);
    expect(parseInline("AT&T R&D; &bogus; &#0; &#xD800; &#xZZ;")).toEqual(["AT&T R&D; &bogus; &#0; &#xD800; &#xZZ;"]);
    // Inside code they stay literal.
    expect(parseInline("`&lt;`")).toEqual([{ t: "code", text: "&lt;" }]);
  });

  it("links emails and www. addresses, and <email> autolinks", () => {
    expect(parseInline("mail me@example.com.")).toEqual(["mail ", { t: "link", href: "mailto:me@example.com", children: ["me@example.com"] }, "."]);
    expect(parseInline("<a@b.co>")).toEqual([{ t: "link", href: "mailto:a@b.co", children: ["a@b.co"] }]);
    expect(parseInline("go to www.example.com/x now")).toEqual([
      "go to ",
      { t: "link", href: "http://www.example.com/x", children: ["www.example.com/x"] },
      " now",
    ]);
    expect(parseInline("not wwwx.com or foo@bar")).toEqual(["not wwwx.com or foo@bar"]);
    // Never nested inside a link label.
    expect(text(parseInline("[me@x.com](https://a.com)"))).toBe("me@x.com");
    expect(parseInline("[me@x.com](https://a.com)")).toMatchObject([{ t: "link", children: ["me@x.com"] }]);
  });

  it("parses images as their own node (never a link), with plain alt text", () => {
    expect(parseInline("![**bold** `c`](out/a.png)")).toEqual([{ t: "image", src: "out/a.png", alt: "bold c" }]);
    expect(parseInline("![x](https://e.com/i.png)")).toEqual([{ t: "image", src: "https://e.com/i.png", alt: "x" }]);
    expect(parseInline("[![b](https://i.io/b.svg)](https://g.com)")).toMatchObject([
      { t: "link", href: "https://g.com/", children: [{ t: "image", alt: "b" }] },
    ]);
  });

  it("keeps link grammar: padded destinations, titles, empty and angle destinations", () => {
    expect(parseInline("[a](  https://a.com/x  )")).toMatchObject([{ t: "link", href: "https://a.com/x", children: ["a"] }]);
    expect(parseInline('[a](https://a.com/x   "t")')).toMatchObject([{ t: "link", href: "https://a.com/x", children: ["a"] }]);
    expect(parseInline("[a](   )")).toMatchObject([{ t: "link", href: null, raw: "" }]);
    expect(parseInline("[a](<>)")).toMatchObject([{ t: "link", raw: "" }]);
    expect(parseInline("[a](" + " ".repeat(500) + "x")).toEqual(["[a](" + " ".repeat(500) + "x"]);
  });

  it("strikes through like GFM", () => {
    expect(parseInline("~one~ ~~two~~")).toMatchObject([{ t: "del", children: ["one"] }, " ", { t: "del", children: ["two"] }]);
    expect(parseInline("~ a ~")).toEqual(["~ a ~"]);
    expect(parseInline("~~~a~~~")).toEqual(["~~~a~~~"]);
  });

  it("accepts angle-bracket link destinations with spaces", () => {
    expect(parseInline("[a](<https://a.com/x y>)")).toMatchObject([{ t: "link", href: "https://a.com/x%20y", children: ["a"] }]);
  });

  it("stays linear on adversarial inline input", () => {
    for (const s of ["~a ".repeat(3000), "a@".repeat(4000), "&".repeat(9000), "![a](".repeat(1800), "www.a".repeat(1800), "***a ".repeat(1800), "a.".repeat(4500) + "@"]) {
      expect(timed(() => parseInline(s)).ms).toBeLessThan(250);
    }
    // `[a](` + thousands of spaces: whitespace around a link destination must not backtrack quadratically.
    const spaced = ("[a](" + " ".repeat(1990) + "x").repeat(8).slice(0, MAX_FORMATTED);
    expect(timed(() => parseInline(spaced.repeat(10).slice(0, MAX_FORMATTED))).ms).toBeLessThan(50);
    expect(timed(() => { for (let i = 0; i < 10; i++) parseInline(spaced); }).ms).toBeLessThan(150);
    expect(timed(() => { for (let i = 0; i < 10; i++) parseInline("~a ".repeat(3333)); }).ms).toBeLessThan(250);
    expect(timed(() => parseBlocks("a\n---\n".repeat(25_000))).ms).toBeLessThan(500);
    expect(timed(() => parseBlocks("\t- x\n".repeat(25_000))).ms).toBeLessThan(500);
  });
});
