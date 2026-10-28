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
  /\brm\s+(-\w*\s+)*-\w*[rRf]/,
  /\bgit\s+push\b.*(--force\b|--force-with-lease\b|\s-f\b)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b.*-\w*f/,
  /(^|[\s;&|(])sudo\b/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+.*\bif=/,
  /:\(\)\s*\{/,
  /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/,
  /\bchmod\s+(-\w+\s+)*-\w*R\w*\s+0?777\b/,
  />\s*\/dev\/(sd|nvme|hd|vd)/,
];

/** Obviously destructive patterns that warrant a confirmation before running. */
export function isDestructive(cmd: string): boolean {
  return DESTRUCTIVE.some((r) => r.test(cmd));
}

/** Terminal tab title: the first command line, truncated. */
export function commandTitle(cmd: string, max = 24): string {
  const first = cmd.split("\n").find((l) => l.trim() !== "" && !l.trim().startsWith("#")) ?? cmd;
  const t = first.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Bytes for the PTY: lines each executed (run) or held on the prompt (bracketed paste when multi-line). */
export function ptyPayload(cmd: string, run: boolean): string {
  const lines = norm(cmd);
  if (run) return lines.join("\r") + "\r";
  return lines.length > 1 ? `\x1b[200~${lines.join("\n")}\x1b[201~` : lines[0];
}
