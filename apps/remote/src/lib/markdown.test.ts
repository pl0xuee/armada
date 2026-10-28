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
