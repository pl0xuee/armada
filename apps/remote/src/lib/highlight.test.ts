import { describe, expect, it } from "vitest";
import { highlight, MAX_HIGHLIGHT, type Tok } from "./highlight";

const text = (t: Tok[]) => t.map((x) => (typeof x === "string" ? x : x.t)).join("");
const classes = (t: Tok[]) => t.filter((x): x is Exclude<Tok, string> => typeof x !== "string").map((x) => `${x.c}:${x.t}`);

describe("highlight", () => {
  it("colours keywords, strings, numbers, calls and comments in JS/TS", () => {
    const t = highlight("const a = foo('x', 42); // done", "ts")!;
    expect(classes(t)).toEqual(["k:const", "f:foo", "s:'x'", "n:42", "c:// done"]);
  });

  it.each([
    ["json", '{"a": [1, true, null]}', ["s:\"a\"", "n:1", "n:true", "n:null"]],
    ["py", "def f(x):  # hi\n  return None", ["k:def", "f:f", "c:# hi", "k:return", "n:None"]],
    ["sh", 'if [ -f "$A" ]; then echo ok; fi # c', ["k:if", 's:"$A"', "k:then", "k:echo", "k:fi", "c:# c"]],
    ["rust", "fn main<'a>() { let c = 'x'; }", ["k:fn", "k:let", "s:'x'"]],
    ["css", "a { color: #fff; margin: 4px } /* x */", ["n:#fff", "n:4px", "c:/* x */"]],
    ["html", '<a href="x">y</a><!-- c -->', ["k:<a", 's:"x"', "k:</a", "c:<!-- c -->"]],
  ])("handles %s", (lang, code, expected) => {
    const t = highlight(code, lang)!;
    expect(classes(t)).toEqual(expected);
    expect(text(t)).toBe(code);
  });

  it("knows common aliases and returns null for unknown languages", () => {
    expect(highlight("let a", "TypeScript")).not.toBeNull();
    expect(highlight("echo", "bash")).not.toBeNull();
    expect(highlight("x", "brainfuck")).toBeNull();
    expect(highlight("x", "")).toBeNull();
    expect(highlight("diff", "diff")).toBeNull(); // diffs are coloured line by line instead
  });

  it("never loses or reorders text, even for broken input", () => {
    const samples = ['"unterminated', "'a", "`tpl ${x}", "/* open", "<!-- open", '"""doc', "\\", "a\u0000b", "é ✓ 🚀", "x\r\ny\t\tz", "'".repeat(500)];
    for (const lang of ["js", "py", "sh", "json", "rust", "css", "html", "go"])
      for (const s of samples) expect(text(highlight(s, lang)!)).toBe(s);
  });

  it("skips very large blocks and stays fast", () => {
    expect(highlight("a".repeat(MAX_HIGHLIGHT + 1), "js")).toBeNull();
    const code = "const a = 'x' + \"y\"; // c\n".repeat(800);
    const t0 = performance.now();
    const t = highlight(code.slice(0, MAX_HIGHLIGHT), "js")!;
    expect(performance.now() - t0).toBeLessThan(200);
    expect(text(t)).toBe(code.slice(0, MAX_HIGHLIGHT));
    const t1 = performance.now();
    highlight("`a".repeat(MAX_HIGHLIGHT / 2), "js");
    highlight("/*".repeat(MAX_HIGHLIGHT / 2), "js");
    expect(performance.now() - t1).toBeLessThan(200);
  });
});
