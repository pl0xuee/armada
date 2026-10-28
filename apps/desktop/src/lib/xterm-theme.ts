import type { ITheme } from "@xterm/xterm";

export const XTERM_FONT = '"JetBrains Mono Variable", ui-monospace, Menlo, monospace';

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** xterm colors from the app's CSS tokens, so terminals follow the theme. */
export function themeFromCss(): ITheme {
  const fg = cssVar("--text-1");
  const accent = cssVar("--accent");
  return {
    background: cssVar("--code-bg"),
    foreground: fg,
    cursor: accent,
    cursorAccent: cssVar("--code-bg"),
    selectionBackground: `${accent}55`,
    black: cssVar("--bg-3"),
    brightBlack: cssVar("--steel"),
    red: cssVar("--err"),
    brightRed: cssVar("--err"),
    green: cssVar("--ok"),
    brightGreen: cssVar("--ok"),
    yellow: cssVar("--warn"),
    brightYellow: cssVar("--warn"),
    blue: accent,
    brightBlue: accent,
    magenta: cssVar("--violet"),
    brightMagenta: cssVar("--violet"),
    cyan: accent,
    brightCyan: accent,
    white: cssVar("--text-2"),
    brightWhite: fg,
  };
}

/** Last `lines` rows of the terminal's buffer as plain text (wrapped rows rejoined, trailing blanks dropped). */
export function bufferTail(term: import("@xterm/xterm").Terminal, lines: number): string {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let i = buf.length - 1; i >= 0 && out.length < lines; i--) {
    const line = buf.getLine(i);
    if (!line) continue;
    let text = line.translateToString(true);
    // A wrapped row continues the one above it: stitch them back into one logical line.
    let j = i;
    while (buf.getLine(j)?.isWrapped && j > 0) {
      j--;
      text = (buf.getLine(j)?.translateToString(false) ?? "") + text;
    }
    i = j;
    out.push(text);
  }
  while (out.length && out[0].trim() === "") out.shift();
  return out.reverse().join("\n");
}

/** Wraps text in a Markdown fence long enough that backticks inside can't end it. */
export function fenced(text: string, label = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${label}\n${text}\n${fence}`;
}
