/** Conversation search on the phone: what to ask the server, and how to show what comes back. */
import type { Agent, SearchGroup, SearchResults } from "./types";

/** Shortest text worth searching for (one letter matches nearly everything). */
export const MIN_QUERY_CHARS = 2;

/** The text to search for, or null when the box holds too little. */
export function searchText(raw: string): string | null {
  const q = raw.trim().replace(/\s+/g, " ");
  return [...q].length >= MIN_QUERY_CHARS ? q : null;
}

/** The server wraps each matched word in these (`MARK_START` / `MARK_END` in the core). */
const MARK_START = "\u0001";
const MARK_END = "\u0002";

export interface SnippetPart {
  text: string;
  hit: boolean;
}

/** A snippet as plain and matched parts, in order. Stray markers are dropped. */
export function splitSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let hit = false;
  let text = "";
  const flush = () => {
    if (text) parts.push({ text, hit });
    text = "";
  };
  for (const ch of snippet) {
    if (ch === MARK_START || ch === MARK_END) {
      flush();
      hit = ch === MARK_START;
    } else {
      text += ch;
    }
  }
  flush();
  return parts;
}

export interface ResultGroup {
  group: SearchGroup;
  agent: Agent;
}

/** The groups whose agent this phone knows (the others can't be opened), best match first. */
export function resultGroups(results: SearchResults | null, agents: Readonly<Record<string, Agent>>): ResultGroup[] {
  if (!results) return [];
  const out: ResultGroup[] = [];
  for (const group of results.groups) {
    const agent = agents[group.agentId];
    if (agent) out.push({ group, agent });
  }
  return out;
}

const KIND_LABEL: Record<string, string> = {
  user_message: "you",
  agent_message: "agent",
  tool_call: "tool",
  permission: "approval",
  question: "question",
  plan: "plan",
  notice: "notice",
  turn_summary: "summary",
};

/** "you", "agent", "tool" ... for a hit's kind; unknown kinds read as their name. */
export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind.replace(/_/g, " ");
}

/** "3 matches", "1 match". */
export function matchCount(total: number): string {
  return `${total} ${total === 1 ? "match" : "matches"}`;
}
