/**
 * Syntax highlighting (Shiki, JavaScript regex engine: no WASM, so the CSP stays strict).
 * Shiki and each grammar load lazily on first use; until then callers render plain text.
 * Colors come from a CSS-variables theme (--syntax-* in globals.css), so switching the app
 * theme never needs re-highlighting.
 */

export interface HlToken {
  /** Text of the token. */
  t: string;
  /** CSS color (a var(--syntax-*) reference), absent for default foreground. */
  c?: string;
  /** Bit flags: 1 italic, 2 bold, 4 underline. */
  s?: number;
}
export type HlLine = HlToken[];

export const MAX_HIGHLIGHT_CHARS = 200_000;
export const MAX_HIGHLIGHT_LINES = 5_000;
/** While a block is still streaming, only this many leading lines are highlighted (the rest renders plain). */
export const STREAMING_HIGHLIGHT_LINES = 800;

// ---------------------------------------------------------------- languages

/** Language ids we ship, each lazily imported on first use. */
const LOADERS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
};

const ALIASES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  json5: "jsonc",
  jsonc: "jsonc",
  rs: "rust",
  py: "python",
  python3: "python",
  golang: "go",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  console: "shellscript",
  "shell-session": "shellscript",
  fish: "shellscript",
  ps1: "powershell",
  pwsh: "powershell",
  yml: "yaml",
  htm: "html",
  svg: "xml",
  plist: "xml",
  md: "markdown",
  mdx: "markdown",
  postgres: "sql",
  postgresql: "sql",
  mysql: "sql",
  sqlite: "sql",
  patch: "diff",
  rb: "ruby",
  kt: "kotlin",
  kts: "kotlin",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  h: "c",
  cs: "csharp",
  "c#": "csharp",
  conf: "ini",
  cfg: "ini",
  properties: "ini",
  docker: "dockerfile",
};

/** Normalise a markdown fence tag ("TS", "language-rust", "ts title=x") to a supported language id, or null. */
export function langFromFence(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const first = tag
    .trim()
    .toLowerCase()
    .split(/[\s{,]/)[0]
    .replace(/^language-/, "");
  if (!first) return null;
  const id = ALIASES[first] ?? first;
  return id in LOADERS ? id : null;
}

/** Language from a file path's name/extension, or null. */
export function langFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const name = path.split(/[\\/]/).pop()!.toLowerCase();
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === "makefile" || name === "cargo.lock") return name === "cargo.lock" ? "toml" : null;
  if (name === ".bashrc" || name === ".zshrc" || name === ".profile" || name === ".bash_profile") return "shellscript";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return langFromFence(name.slice(dot + 1));
}

// -------------------------------------------------------------------- cache

/** Small LRU keyed by language + code; bounded by entry count and total characters. */
export class LruCache<V> {
  private map = new Map<string, { value: V; size: number }>();
  private total = 0;
  constructor(
    private maxEntries: number,
    private maxSize: number,
  ) {}
  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }
  set(key: string, value: V, size = 1): void {
    const old = this.map.get(key);
    if (old) {
      this.total -= old.size;
      this.map.delete(key);
    }
    this.map.set(key, { value, size });
    this.total += size;
    while (this.map.size > this.maxEntries || (this.total > this.maxSize && this.map.size > 1)) {
      const k = this.map.keys().next().value as string;
      this.total -= this.map.get(k)!.size;
      this.map.delete(k);
    }
  }
  get size(): number {
    return this.map.size;
  }
}

const cache = new LruCache<HlLine[]>(300, 2_000_000);
const cacheKey = (lang: string, code: string) => `${lang}\u0000${code}`;

/** Whether `code` is small enough to highlight. */
export function canHighlight(code: string): boolean {
  if (code.length > MAX_HIGHLIGHT_CHARS) return false;
  let lines = 1;
  for (let i = code.indexOf("\n"); i >= 0; i = code.indexOf("\n", i + 1)) {
    if (++lines > MAX_HIGHLIGHT_LINES) return false;
  }
  return true;
}

/** The first `n` lines of `code` (the whole string when it has no more). */
export function headLines(code: string, n: number): string {
  let end = -1;
  for (let i = 0; i < n; i++) {
    end = code.indexOf("\n", end + 1);
    if (end < 0) return code;
  }
  return code.slice(0, end);
}

/** Cached result, if any (synchronous, for first paint). */
export function peekHighlight(lang: string | null, code: string): HlLine[] | null {
  if (!lang) return null;
  return cache.get(cacheKey(lang, code)) ?? null;
}

// ---------------------------------------------------------------- tokenizing

interface Core {
  loadLanguage(...l: unknown[]): Promise<void>;
  codeToTokensBase(
    code: string,
    o: Record<string, unknown>,
  ): { content: string; color?: string; fontStyle?: number }[][];
}

let corePromise: Promise<Core> | null = null;
const langPromises = new Map<string, Promise<void>>();
const FG = "var(--syntax-foreground)";

function getCore(): Promise<Core> {
  corePromise ??= (async () => {
    const [{ createHighlighterCore, createCssVariablesTheme }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]);
    const theme = createCssVariablesTheme({ name: "armada", variablePrefix: "--syntax-", fontStyle: true });
    return (await createHighlighterCore({
      themes: [theme],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    })) as unknown as Core;
  })();
  corePromise.catch(() => (corePromise = null));
  return corePromise;
}

function ensureLang(core: Core, lang: string): Promise<void> {
  let p = langPromises.get(lang);
  if (!p) {
    p = LOADERS[lang]().then((m) => core.loadLanguage((m as { default: unknown }).default));
    p.catch(() => langPromises.delete(lang));
    langPromises.set(lang, p);
  }
  return p;
}

export interface HighlightOptions {
  /** Streaming mode: highlight only the first N lines; the result then has N lines, not all of them. */
  maxLines?: number;
}

/** Highlight `code`; resolves null when unsupported, too large, or Shiki fails. Results are cached. */
export async function highlight(
  lang: string | null,
  code: string,
  opts: HighlightOptions = {},
): Promise<HlLine[] | null> {
  if (!lang || !(lang in LOADERS)) return null;
  const partial = opts.maxLines !== undefined && opts.maxLines > 0;
  if (partial) code = headLines(code, opts.maxLines!);
  if (!canHighlight(code)) return null;
  const key = cacheKey(lang, code);
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const core = await getCore();
    await ensureLang(core, lang);
    const raw = core.codeToTokensBase(code, { lang, theme: "armada", tokenizeMaxLineLength: 3000 });
    const lines: HlLine[] = raw.map((line) =>
      line.map((tk) => {
        const out: HlToken = { t: tk.content };
        if (tk.color && tk.color !== FG) out.c = tk.color;
        if (tk.fontStyle && tk.fontStyle > 0) out.s = tk.fontStyle;
        return out;
      }),
    );
    cache.set(key, lines, code.length);
    return lines;
  } catch {
    return null;
  }
}

/** Languages worth loading ahead of the first code block. */
const PREWARM_LANGS = ["typescript", "tsx", "json", "shellscript", "rust", "python"];

/** Load the Shiki core and the common grammars (one at a time, so each is a short task). */
export async function prewarmHighlighter(langs: string[] = PREWARM_LANGS): Promise<void> {
  try {
    const core = await getCore();
    for (const lang of langs) {
      if (lang in LOADERS) await ensureLang(core, lang);
    }
  } catch {
    /* highlighting loads on demand later */
  }
}

// ------------------------------------------------------------- pure helpers

export const lineText = (l: HlLine): string => l.map((t) => t.t).join("");

/**
 * While a growing block waits to be re-highlighted, keep the colors of lines that haven't
 * changed (a stream only appends) and render the rest plain, so nothing flashes.
 */
export function mergeStale(prev: HlLine[] | null, code: string): HlLine[] {
  const lines = code.split("\n");
  return lines.map((text, i) => {
    const p = prev?.[i];
    if (p && lineText(p) === text) return p;
    return text ? [{ t: text }] : [];
  });
}

/** Minimal shape of a diff line used for token mapping (see lib/diff.ts DiffLine). */
export interface TokenizableDiffLine {
  type: "context" | "add" | "del";
  text: string;
}

/** The old-side and new-side source text of a hunk. */
export function hunkSides(lines: TokenizableDiffLine[]): { oldText: string; newText: string } {
  const o: string[] = [];
  const n: string[] = [];
  for (const l of lines) {
    if (l.type !== "add") o.push(l.text);
    if (l.type !== "del") n.push(l.text);
  }
  return { oldText: o.join("\n"), newText: n.join("\n") };
}

/**
 * Map per-side highlighted lines back onto diff lines: deletions take old-side tokens,
 * context and additions take new-side tokens. Returns null per line when a side is missing.
 */
export function mapDiffTokens(
  lines: TokenizableDiffLine[],
  oldTokens: HlLine[] | null,
  newTokens: HlLine[] | null,
): (HlLine | null)[] {
  let oi = 0;
  let ni = 0;
  return lines.map((l) => {
    if (l.type === "del") return oldTokens?.[oi++] ?? null;
    if (l.type === "add") return newTokens?.[ni++] ?? null;
    const o = oldTokens?.[oi++];
    const n = newTokens?.[ni++];
    return n ?? o ?? null;
  });
}
