/**
 * A tiny, dependency-free syntax highlighter for code blocks in agent replies.
 * The desktop app uses Shiki, which is far too heavy for the phone's single
 * HTML file; this covers the common languages with one regex tokenizer per
 * language family (comments, strings, numbers, keywords, calls). It is a
 * single linear pass, never produces HTML (callers render the tokens as
 * text nodes) and skips very large blocks.
 *
 * Token classes: k keyword, s string, c comment, n number/constant, f call.
 */
export type Tok = string | { c: "k" | "s" | "c" | "n" | "f"; t: string };

export const MAX_HIGHLIGHT = 24_000;

const C_KW =
  "as async await break case catch class const continue default defer delete do else enum export extends false final finally fn for from func function go if impl import in interface let loop match mod mut new null nil of override package private protected pub public readonly return self static struct super switch this throw throws trait true try type typeof undefined use var void where while with yield";
const PY_KW =
  "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield None True False self";
const SH_KW = "if then else elif fi for while until do done case esac in function return exit export local set unset echo cd source";

interface Lang {
  /** Line-comment marker, if any. */
  line?: string;
  /** Block comment delimiters (open, close). */
  block?: [string, string];
  kw: string;
  /** Template literals / triple quotes. */
  multi?: boolean;
  /** Single quotes hold one character (Rust lifetimes, Go runes), not a string. */
  chr?: boolean;
}

const CLIKE: Lang = { line: "//", block: ["/*", "*/"], kw: C_KW, multi: true };
const TYPED: Lang = { ...CLIKE, chr: true };
const LANGS: Record<string, Lang> = {
  js: CLIKE,
  ts: CLIKE,
  rust: TYPED,
  go: TYPED,
  java: TYPED,
  c: TYPED,
  py: { line: "#", kw: PY_KW, multi: true },
  sh: { line: "#", kw: SH_KW },
  json: { kw: "true false null" },
  css: { block: ["/*", "*/"], kw: "important" },
  html: { block: ["<!--", "-->"], kw: "" },
};
const ALIAS: Record<string, string> = {
  javascript: "js", jsx: "js", mjs: "js", cjs: "js", typescript: "ts", tsx: "ts", rs: "rust", golang: "go",
  kotlin: "java", swift: "java", cpp: "c", "c++": "c", cs: "java", csharp: "java", python: "py", bash: "sh", shell: "sh",
  zsh: "sh", console: "sh", jsonc: "json", scss: "css", less: "css", xml: "html", svg: "html", vue: "html",
};

const CONST = /^(?:true|false|null|nil|None|True|False|undefined)$/;
const esc =(s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const cache = new Map<string, RegExp>();

function tokenizer(name: string, l: Lang): RegExp {
  let re = cache.get(name);
  if (re) return re;
  const parts: string[] = [];
  if (l.block) parts.push(`${esc(l.block[0])}[\\s\\S]*?(?:${esc(l.block[1])}|$)`);
  if (l.line) parts.push(`${esc(l.line)}[^\\n]*`);
  // Groups: 1 comment | 2 string | 3 number | 4 call | 5 word
  const comment = parts.join("|") || "(?!)";
  const single = l.chr ? `'(?:\\\\[^\\n]|[^'\\\\\\n])'` : `'(?:[^'\\\\\\n]|\\\\.)*'?`;
  const str = (l.multi ? '"""[\\s\\S]*?(?:"""|$)|`(?:[^`\\\\]|\\\\[\\s\\S])*`?|' : "") + `"(?:[^"\\\\\\n]|\\\\.)*"?|${single}`;
  const html = name === "html";
  re = new RegExp(
    `(${comment})|(${str})|(${html ? "(?!)" : "\\b\\d[\\w.]*|#[0-9a-fA-F]{3,8}\\b"})|(${html ? "</?[A-Za-z][\\w:-]*" : "[A-Za-z_$][\\w$]*(?=\\()"})|([A-Za-z_$][\\w$]*|\\s+|[\\s\\S])`,
    "g",
  );
  cache.set(name, re);
  return re;
}

/** Tokens for `code`, or null when the language isn't supported (or the block is huge). */
export function highlight(code: string, lang: string): Tok[] | null {
  const key = lang.toLowerCase();
  const name = ALIAS[key] ?? key;
  const l = LANGS[name];
  if (!l || code.length > MAX_HIGHLIGHT) return null;
  const kw = new Set(l.kw.split(" "));
  const html = name === "html";
  const re = tokenizer(name, l);
  re.lastIndex = 0;
  const out: Tok[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push(plain);
    plain = "";
  };
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const t = m[0];
    if (!t) {
      re.lastIndex++; // zero-length guard (cannot happen with these patterns, but never loop)
      continue;
    }
    const c =
      m[1] !== undefined ? "c" : m[2] !== undefined ? "s" : m[3] ? "n" : m[4] ? (html || kw.has(t) ? "k" : "f") : kw.has(t) ? (CONST.test(t) ? "n" : "k") : null;
    if (c) {
      flush();
      out.push({ c, t });
    } else plain += t;
  }
  flush();
  return out;
}
