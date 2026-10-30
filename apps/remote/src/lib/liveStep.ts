/**
 * The one line that says what the agent is doing right now ("Running `npm test`", "Reading foo.ts",
 * "Writing…"). Pure: derived from the newest unfinished item of the current turn, so it needs no
 * live state of its own. Everything else in the timeline stays a static summary.
 */
import { basename, plural } from "./format";
import { isPictureOnly, isRunning } from "./rows";
import { workingLabel } from "./thinking";
import type { TimelineItem, ToolCallItem } from "./types";

export interface LiveStep {
  kind: "starting" | "subagents" | "command" | "file" | "search" | "fetch" | "tool" | "thought" | "writing" | "verb";
  /** The sentence; for a command the lead-in ("Running"), the command itself being `code`. */
  text: string;
  /** Shown in mono after `text` (a shell command). */
  code?: string;
}

export interface LiveStepOpts {
  starting: boolean;
  name: string;
  subagents: number;
  /** Which cycling verb to show when nothing more specific is known. */
  verb: number;
  offset: number;
}

const MAX_CODE = 240;

const firstLine = (s: string | null | undefined): string => (s ?? "").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";

/** The query out of a search call's title (`Grep "foo"`, `Search \`foo\``), if it has one. */
function searchQuery(title: string): string {
  return /["'`“]([^"'`”]+)["'`”]/.exec(title)?.[1]?.trim() ?? "";
}

/** The host of the first URL in a fetch call's title. */
function fetchHost(title: string): string {
  const url = /https?:\/\/[^\s"'`)]+/.exec(title)?.[0];
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** "Reading foo.ts" / "Editing 2 files": `calls` are the unfinished calls of one kind, newest last. */
function describeTools(calls: ToolCallItem[]): LiveStep {
  const last = calls[calls.length - 1];
  const n = calls.length;
  const files = new Set(calls.flatMap((c) => c.locations.map((l) => basename(l) || l)));
  const fileCount = Math.max(files.size, n);
  const file = last.locations[0] ? basename(last.locations[0]) || last.locations[0] : "";
  const title = firstLine(last.title);
  switch (last.toolKind) {
    case "execute": {
      if (n > 1) return { kind: "command", text: `Running ${plural(n, "command")}` };
      const cmd = firstLine(last.command) || title;
      return cmd ? { kind: "command", text: "Running", code: cmd.slice(0, MAX_CODE) } : { kind: "command", text: "Running a command" };
    }
    case "read":
    case "edit":
    case "delete":
    case "move": {
      const verb = { read: "Reading", edit: "Editing", delete: "Deleting", move: "Moving" }[last.toolKind];
      if (fileCount > 1) return { kind: "file", text: `${verb} ${plural(fileCount, "file")}` };
      if (file) return { kind: "file", text: `${verb} ${file}` };
      return { kind: "file", text: title || `${verb} a file` };
    }
    case "search": {
      if (n > 1) return { kind: "search", text: `Running ${plural(n, "search", "searches")}` };
      const q = searchQuery(title);
      return { kind: "search", text: q ? `Searching for “${q}”` : "Searching" };
    }
    case "fetch": {
      if (n > 1) return { kind: "fetch", text: `Fetching ${plural(n, "page")}` };
      const host = fetchHost(title);
      return { kind: "fetch", text: host ? `Fetching ${host}` : "Fetching a page" };
    }
    case "think":
      return { kind: "thought", text: "Thinking…" };
    default:
      return { kind: "tool", text: title || "Working…" };
  }
}

/** The newest unfinished top-level call of the current turn, with the unfinished calls of its kind. */
function unfinishedCalls(items: readonly TimelineItem[]): ToolCallItem[] {
  let newest: ToolCallItem | null = null;
  const same: ToolCallItem[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user_message" || it.kind === "turn_summary") break;
    // A sub-agent's own calls belong to its card; a Codex wait/close call is plain work.
    if (it.kind !== "tool_call" || !isRunning(it) || it.parentToolCallId) continue;
    if (!newest) newest = it;
    if (it.toolKind === newest.toolKind) same.unshift(it);
  }
  return same;
}

/**
 * What to say while the agent is busy. In order: starting, waiting on sub-agents, then the newest
 * item of the turn (a streaming thought or message), then the newest unfinished tool call, then the
 * cycling verbs.
 */
export function liveStep(items: readonly TimelineItem[], opts: LiveStepOpts): LiveStep {
  if (opts.starting) return { kind: "starting", text: workingLabel(opts) };
  if (opts.subagents > 0) return { kind: "subagents", text: workingLabel(opts) };
  const last = items[items.length - 1];
  if (last?.kind === "thought") return { kind: "thought", text: "Thinking…" };
  if (last?.kind === "agent_message" && !isPictureOnly(last)) return { kind: "writing", text: "Writing…" };
  const calls = unfinishedCalls(items);
  if (calls.length) return describeTools(calls);
  return { kind: "verb", text: workingLabel({ ...opts, starting: false, subagents: 0 }) };
}

/** `step` as plain text (aria labels, tests). */
export const stepText = (s: LiveStep): string => (s.code ? `${s.text} ${s.code}` : s.text);
