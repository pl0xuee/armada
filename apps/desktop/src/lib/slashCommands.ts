import type { SlashCommand } from "./types";

/** The first letter of each word of a command: "remote-control" → "rc". */
export function commandInitials(name: string): string {
  return name
    .replace(/^\//, "")
    .split(/[-_:\s]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .toLowerCase();
}

/**
 * How well `query` (lowercase, without the slash) finds a command, best first:
 * 0 = name starts with it, 1 = its initials do ("rc" → remote-control),
 * 2 = name contains it; null = no match.
 */
export function commandRank(name: string, query: string): number | null {
  const n = name.replace(/^\//, "").toLowerCase();
  if (n.startsWith(query)) return 0;
  if (query.length >= 2 && commandInitials(n).startsWith(query)) return 1;
  if (n.includes(query)) return 2;
  return null;
}

/**
 * Expands a shortcut typed in full, the way Claude Code does `/rc`: when the
 * message starts with `/<word>` that is no command's name but exactly one
 * command's initials, the command's full name replaces it. Agents only act on
 * the real name, so `/rc` would otherwise reach the model as plain text.
 */
export function expandCommandShortcut(text: string, commands: SlashCommand[]): string {
  const m = /^\/([\w-]+)(?=\s|$)/.exec(text.trimStart());
  if (!m) return text;
  const word = m[1].toLowerCase();
  const names = commands.map((c) => c.name.replace(/^\//, ""));
  if (word.length < 2 || names.some((n) => n.toLowerCase() === word)) return text;
  const hits = names.filter((n) => commandInitials(n) === word);
  if (hits.length !== 1) return text;
  const start = text.indexOf("/");
  return `${text.slice(0, start)}/${hits[0]}${text.slice(start + 1 + m[1].length)}`;
}
