/** Only the tail of very long output is processed. */
const OUTPUT_CAP = 200_000;

// CSI (colors, cursor moves), OSC (titles, hyperlinks) and other two-byte escapes.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Terminal output as plain text: strips ANSI escapes and applies carriage returns the way a
 * terminal would (a progress bar redrawn with \r keeps only its last state). Same as the desktop's
 * `cleanTerminalOutput`.
 */
export function cleanTerminalOutput(raw: string): { text: string; hidden: number } {
  const hidden = Math.max(0, raw.length - OUTPUT_CAP);
  const tail = hidden ? raw.slice(hidden) : raw;
  const text = tail
    .replace(ANSI_RE, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const cr = line.lastIndexOf("\r");
      return cr >= 0 ? line.slice(cr + 1) : line;
    })
    .join("\n");
  return { text, hidden };
}

/** "exit 1" from the end of a failed command's output, when it says so. */
export function exitCodeOf(output: string): string | null {
  const m = /(?:exit(?:ed)?(?: with)?(?: code| status)?|code)[:= ]+(-?\d+)\s*\)?\s*$/i.exec(output.trimEnd().slice(-200));
  return m ? m[1] : null;
}
