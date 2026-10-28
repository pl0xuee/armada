// Pure helpers for the "Run" button on shell code blocks in agent messages.

const POSIX_SHELLS = new Set(["bash", "sh", "shell", "shellscript", "zsh", "console", "terminal", "shell-session"]);
const WINDOWS_SHELLS = new Set(["powershell", "ps1", "pwsh", "cmd", "bat"]);
/** Transcript-style fences, where lines may be "$ cmd" followed by output. */
const SESSION_LANGS = new Set(["console", "terminal", "shell-session"]);
/** First words that make an untagged block plainly a command. */
const COMMON = new Set([
  "git", "npm", "npx", "pnpm", "yarn", "bun", "cargo", "rustup", "cd", "ls", "mkdir", "curl", "wget", "docker",
  "pip", "pip3", "python", "python3", "brew", "apt", "apt-get", "make", "cmake", "go", "node", "deno", "gh", "kubectl",
]); // prettier-ignore

function tag(lang: string | null | undefined): string {
  return (lang ?? "")
    .trim()
    .toLowerCase()
    .split(/[\s{,]/)[0];
}

/** Is this fence language a shell we can run in the agent's terminal? */
export function isShellLang(lang: string | null | undefined, platform: string): boolean {
  const t = tag(lang);
  return POSIX_SHELLS.has(t) || (platform === "windows" && WINDOWS_SHELLS.has(t));
}

const PROMPT = /^\s*[$>]\s+(.*)$/;

function norm(code: string): string[] {
  return code.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
}

/**
 * The text to send to the shell for a block, or "" if there's nothing to run. Strips "$ " / "> "
 * prompts: in console-style blocks only prompted lines are kept (the rest is output); in other
 * shell blocks prompts are stripped only when every non-comment line has one.
 */
export function commandText(code: string, lang: string | null | undefined): string {
  const lines = norm(code);
  const content = lines.filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  const prompted = content.filter((l) => PROMPT.test(l));
  let out = lines;
  if (SESSION_LANGS.has(tag(lang)) && prompted.length > 0) {
    out = prompted.map((l) => PROMPT.exec(l)![1]);
  } else if (prompted.length > 0 && prompted.length === content.length) {
    out = lines.map((l) => PROMPT.exec(l)?.[1] ?? l);
  }
  return out.join("\n").trim();
}

/** Untagged block that is trivially a command: every non-empty line starts with a well-known tool or "$ ". */
export function looksLikeCommand(code: string): boolean {
  const content = norm(code).filter((l) => l.trim() !== "");
  if (content.length === 0 || content.length > 20) return false;
  return content.every((l) => {
    const m = PROMPT.exec(l);
    if (m && l.trim().startsWith("$")) return true;
    return !m && COMMON.has(l.trim().split(/\s+/)[0]);
  });
}

const DESTRUCTIVE: RegExp[] = [
  /\brm\s+(\S+\s+)*-{1,2}\w*[rRf]/,
  /\b(rmdir|unlink|shred|truncate)\b/,
  /\bfind\b[^\n]*(-delete\b|-exec\b|-execdir\b|-ok\b)/,
  /\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|--mirror\b|--delete\b|\s-\w*[fd]\b|\s\+\S|\s:\S)/,
  /\bgit\s+(reset\s+--hard|clean|restore|checkout\s+(\S+\s+)*--|branch\s+(\S+\s+)*-\w*[dD]|stash\s+(drop|clear))(?!\w)/,
  /(^|[\s;&|(`])(sudo|doas|su|pkexec|runas)\b/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+.*\bif=/,
  /:\(\)\s*\{/,
  /\|\s*(env\s+\S+\s+)?(sudo\s+)?(ba|z|da|k|fi)?sh\b/,
  /\b(eval|source)\b/,
  /\bchmod\s+(-\w+\s+)*-\w*R/,
  />\s*(\/dev\/|~|\$HOME|\/etc\/|\.\w)/,
  /\b(powershell|pwsh)\b[^\n]*-(e|enc|encodedcommand)\b/i,
  /\b(rd|rmdir|del|erase)\s+\/[sq]/i,
  /\bRemove-Item\b/i,
];

/** Obviously destructive patterns, used only to choose the confirmation wording. */
export function isDestructive(cmd: string): boolean {
  return DESTRUCTIVE.some((r) => r.test(cmd));
}

// ---- Hidden characters -------------------------------------------------------------------

// Everything that can make displayed text differ from what a terminal receives: C0/C1 controls
// (except \n, \t, and \r in a CRLF pair), DEL, bidi controls, zero-width/invisible formatting,
// line/paragraph separators, soft hyphen, Arabic letter mark, Mongolian vowel separator, BOM
// and Unicode tag characters.
const HIDDEN = new RegExp(
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u00AD\\u061C\\u180E" +
    "\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB]|\\r(?!\\n)|\\uDB40[\\uDC00-\\uDC7F]",
  "g",
);

export interface HiddenChar {
  index: number;
  text: string;
}

/** Characters in `text` that are invisible or would act as terminal/readline controls. */
export function findHiddenChars(text: string): HiddenChar[] {
  const out: HiddenChar[] = [];
  for (const m of text.matchAll(HIDDEN)) out.push({ index: m.index ?? 0, text: m[0] });
  return out;
}

function marker(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x20) return String.fromCodePoint(0x2400 + cp); // ␀ … ␛ …
  if (cp === 0x7f) return "\u2421";
  return `\u27e8U+${cp.toString(16).toUpperCase().padStart(4, "0")}\u27e9`;
}

/** `text` with every hidden character replaced by a visible marker (␛, ⟨U+202E⟩, …). */
export function revealHidden(text: string): string {
  return text.replace(HIDDEN, marker);
}

// ---- Run policy --------------------------------------------------------------------------

/** Shell metacharacters: pipes, lists, background, expansion, redirection, grouping, escapes, history. */
const META = /[|;&$`<>(){}\\!\n\r]/;
/** Options that make otherwise read-only tools write files or run other programs. */
const DANGEROUS_OPT = /(^|\s)--(output|pre|exec|upload-pack|receive-pack|ext-diff|open-files-in-pager|textconv)\b/;
const NODE_PM = new Set(["npm", "pnpm", "yarn", "bun"]);

/** A relative path or name that stays inside the project: no absolute/home/drive/URL/`..`/quotes. */
function safeRel(a: string): boolean {
  if (a === "" || a.startsWith("-") || /["']/.test(a)) return false;
  if (/^[/~]/.test(a) || /^[A-Za-z]:/.test(a) || a.includes("://")) return false;
  return !a.split("/").includes("..");
}

/** A search pattern or relative path for grep/rg: quotes are fine, escaping the project is not. */
function safePatternOrRel(a: string): boolean {
  const u = a.replace(/^["']+/, "");
  if (a.startsWith("-") || /^[/~]/.test(u) || /^[A-Za-z]:[\\/]/.test(u) || u.includes("://")) return false;
  return !u.split("/").includes("..");
}

interface ArgRules {
  /** Flags that take no value. */
  flags?: RegExp;
  /** Flags whose next token must satisfy `val`. */
  valued?: Set<string>;
  val?: (v: string) => boolean;
  /** Validator for non-flag tokens (default: none allowed). */
  pos?: (a: string) => boolean;
}

/** Every token must be an allowed flag, an allowed flag value, or an allowed positional. */
function argsOk(tokens: string[], r: ArgRules): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (a.startsWith("-")) {
      if (r.valued?.has(a)) {
        const v = tokens[++i];
        if (v === undefined || !(r.val ?? safeRel)(v)) return false;
      } else if (!r.flags?.test(a)) return false;
    } else if (!r.pos?.(a)) return false;
  }
  return true;
}

const SHORT = /^-[A-Za-z0-9]+$/;
const SCRIPT = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;
const CRATE = /^[A-Za-z0-9_-]+$/;
const GIT_LONG =
  /^--(stat|oneline|name-only|name-status|graph|all|cached|staged|shortstat|numstat|no-color|color|short|porcelain|branch|decorate|patch|summary|abbrev-commit|no-merges|merges|first-parent|reverse|max-count=\d+|format=[\w%:.,-]+|pretty=[\w%:.,-]+|author=[\w.@-]+|since=[\w.-]+|until=[\w.-]+)$/;
const GREP_LONG =
  /^--(ignore-case|line-number|no-heading|hidden|count|fixed-strings|word-regexp|files-with-matches|invert-match|recursive|color=(never|always|auto)|no-ignore|smart-case|context=\d+)$/;

function nodePmOk(t: string[]): boolean {
  const sub = t[1];
  const rest = t.slice(2);
  const quiet = /^--(silent|if-present|ignore-scripts|frozen-lockfile|prefer-offline|offline)$|^-s$/;
  if (["test", "t", "install", "i", "ci"].includes(sub)) return argsOk(rest, { flags: quiet });
  if (sub === "run") return rest.length >= 1 && SCRIPT.test(rest[0]) && argsOk(rest.slice(1), { flags: quiet });
  return false;
}

function cargoOk(t: string[]): boolean {
  const sub = t[1];
  if (!["build", "check", "test", "fmt", "clippy"].includes(sub)) return false;
  const dd = t.indexOf("--");
  const head = dd === -1 ? t.slice(2) : t.slice(2, dd);
  const tail = dd === -1 ? [] : t.slice(dd + 1);
  const ok = argsOk(head, {
    flags: /^--(release|workspace|all|all-targets|all-features|locked|frozen|offline|quiet|check|lib|bins|tests|examples|benches|no-fail-fast|no-run)$|^-q$/,
    valued: new Set(["-p", "--package"]),
    val: (v) => CRATE.test(v),
    pos: sub === "test" ? (a) => /^[A-Za-z0-9_:]+$/.test(a) : undefined,
  });
  if (!ok) return false;
  if (tail.length === 0) return dd === -1;
  if (sub === "clippy") {
    for (let i = 0; i < tail.length; i += 2) {
      if (!/^-[DWAF]$/.test(tail[i]) || !/^[a-z_:]+$/.test(tail[i + 1] ?? "")) return false;
    }
    return true;
  }
  if (sub === "test") return tail.every((a) => /^--(nocapture|ignored|show-output|test-threads=\d+)$/.test(a));
  return false;
}

function goOk(t: string[]): boolean {
  if (!["build", "test", "vet"].includes(t[1])) return false;
  return argsOk(t.slice(2), {
    flags: /^-(v|race|short|count=\d+|run=[\w.*^]+)$/,
    pos: (a) => /^\.\/[\w./-]*$/.test(a) && !a.split("/").includes(".."),
  });
}

function gitOk(t: string[]): boolean {
  const sub = t[1];
  const rest = t.slice(2);
  const rev = (a: string) =>
    /^[\w@.^~:/+-]+$/.test(a) && !/^[/~]/.test(a) && !a.includes("://") && !a.split("/").includes("..");
  switch (sub) {
    case "status": case "diff": case "log": case "show":
      return argsOk(rest, { flags: new RegExp(`${SHORT.source}|${GIT_LONG.source}`), pos: rev });
    case "branch":
      return argsOk(rest, { flags: /^-(a|r|v|vv)$|^--(all|remotes|list|show-current|verbose)$/ });
    case "fetch":
      return argsOk(rest, { flags: /^--(all|prune)$|^-p$/, pos: (a) => /^[A-Za-z0-9_-]+$/.test(a) });
    default:
      return false;
  }
}

function isSimpleLine(line: string): boolean {
  if (META.test(line) || DANGEROUS_OPT.test(line)) return false;
  const t = line.trim().split(/\s+/);
  const [head, sub] = t;
  const rest = t.slice(1);
  switch (head) {
    case "pwd":
      return argsOk(rest, { flags: SHORT });
    case "ls": case "cat": case "head": case "tail": case "wc":
      return argsOk(rest, { flags: SHORT, pos: safeRel });
    case "cd":
      return argsOk(rest, { pos: safeRel });
    case "echo":
      return !rest.some((a) => /^[/~]/.test(a));
    case "grep": case "rg":
      return argsOk(rest, {
        flags: new RegExp(`${SHORT.source}|${GREP_LONG.source}`),
        pos: safePatternOrRel,
      }) && !rest.some((a) => /^-[A-Za-z0-9]*[fz]/.test(a));
    case "make":
      return argsOk(rest, { flags: /^-j\d*$/, pos: (a) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(a) });
    case "pytest":
      return argsOk(rest, { flags: /^-(q|qq|v|vv|x|s)$|^--tb=\w+$/, pos: safeRel });
    case "python": case "python3":
      return sub === "-m" && t[2] === "pytest" && isSimpleLine(["pytest", ...t.slice(3)].join(" "));
    case "git":
      return gitOk(t);
    case "npx":
      return sub === "tsc" && argsOk(t.slice(2), { flags: /^--(noEmit|pretty)$|^-b$/, valued: new Set(["-p"]) });
    case "cargo":
      return cargoOk(t);
    case "go":
      return goOk(t);
    default:
      return NODE_PM.has(head) && nodePmOk(t);
  }
} // prettier-ignore

/**
 * True only when every line is a comment or a single common read-only/dev command with no shell
 * metacharacters. Anything else (pipes, substitution, redirects, unknown programs, wrappers like
 * env/doas) must be confirmed by the user before it runs.
 */
export function isSimpleCommand(cmd: string): boolean {
  const lines = norm(cmd).filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  return lines.length > 0 && lines.every(isSimpleLine);
}

export type RunPolicy = "run" | "confirm" | "confirm-destructive";

/** What the Run button (and Ctrl/Cmd+Enter) must do for this command. */
export function runPolicy(cmd: string): RunPolicy {
  if (isDestructive(cmd)) return "confirm-destructive";
  return isSimpleCommand(cmd) ? "run" : "confirm";
}

/** Terminal tab title: the first command line, truncated. */
export function commandTitle(cmd: string, max = 24): string {
  const first = cmd.split("\n").find((l) => l.trim() !== "" && !l.trim().startsWith("#")) ?? cmd;
  const t = first.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Control characters, bidi/zero-width characters and ESC sequences never reach the PTY. */
function sanitize(cmd: string): string {
  return cmd.replace(HIDDEN, "");
}

/**
 * Bytes for the PTY: lines each executed (run) or held on the prompt (bracketed paste when
 * multi-line). Control characters (including ESC, so no pasted `\x1b[201~` terminator) are
 * stripped; tabs become spaces outside a bracketed paste so readline doesn't complete them.
 */
export function ptyPayload(cmd: string, run: boolean): string {
  const lines = norm(sanitize(cmd));
  if (run) return lines.join("\r").replace(/\t/g, " ") + "\r";
  return lines.length > 1 ? `\x1b[200~${lines.join("\n")}\x1b[201~` : lines[0].replace(/\t/g, " ");
}
