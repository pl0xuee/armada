/**
 * Claude's Bash tool hands command output over inside a markdown fence (```console … ```),
 * which is formatting, not output. Strips the opening fence line and, when there was one (or
 * the start was cut off), the closing one. `tailCut`: only the end of a long output is kept,
 * so the opening fence may be gone.
 */
export function stripOutputFence(text: string, tailCut = false): string {
  let t = text;
  let opened = false;
  const open = /^```[A-Za-z0-9_-]*[ \t]*\n/.exec(t);
  if (open) {
    t = t.slice(open[0].length);
    opened = true;
  } else if (/^```[A-Za-z0-9_-]*[ \t]*$/.test(t)) {
    // Only the opening fence has arrived so far (a command that just started).
    return "";
  }
  if (opened || tailCut) t = t.replace(/(?:^|\n)```[ \t]*\n?$/, "");
  return t;
}
