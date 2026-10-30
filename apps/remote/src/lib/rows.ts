/**
 * Turns a flat timeline into display rows: runs of plain tool calls, thoughts and interim
 * messages fold into one "activity group" row (like the desktop's), and calls that ran under a
 * sub-agent are nested under the call that launched it (recursively), instead of interleaving
 * with the main flow.
 */
import { groupActivity } from "./activity";
import { estimateQuestion, summarize } from "./question";
import type { TimelineItem, ToolCallItem } from "./types";

export interface SubagentNode {
  call: ToolCallItem;
  /** Calls made by this sub-agent, in timeline order (each may be a sub-agent itself). */
  children: (ToolCallItem | SubagentNode)[];
  /** All descendant tool calls (for the "N tool calls" count). */
  total: number;
}

export type Row =
  | { kind: "item"; key: string; item: TimelineItem }
  | { kind: "tools"; key: string; tools: ToolCallItem[] }
  /** A run of finished-looking work (tool calls, thoughts, interim messages) folded into one line. */
  | { kind: "group"; key: string; items: TimelineItem[] }
  | { kind: "subagent"; key: string; node: SubagentNode };

export interface BuildOptions {
  /** The agent is only waiting on sub-agents: the trailing run folds even when it is a single row. */
  foldTail?: boolean;
  /** Ids of standalone rows on screen: they stay out of groups so the reader's content doesn't collapse. */
  keep?: ReadonlySet<string>;
}

export const isRunning = (c: ToolCallItem) => c.status === "pending" || c.status === "in_progress";

export function isSubagentNode(x: ToolCallItem | SubagentNode): x is SubagentNode {
  return "call" in x;
}

/** A call that launched a sub-agent. Codex wait/close/send calls (`control`) manage existing ones: plain tool calls. */
export const isLauncher = (it: TimelineItem): it is ToolCallItem => it.kind === "tool_call" && !!it.subagent && !it.subagent.control;

export function buildRows(items: TimelineItem[], opts: BuildOptions = {}): Row[] {
  // Sub-agent launchers by their tool call id.
  const launchers = new Map<string, ToolCallItem>();
  for (const it of items) if (isLauncher(it) && it.toolCallId) launchers.set(it.toolCallId, it);

  const childrenOf = new Map<string, ToolCallItem[]>();
  const nested = new Set<string>();
  for (const it of items) {
    if (it.kind !== "tool_call" || !it.parentToolCallId) continue;
    // Only nest under a known launcher (and never under itself).
    if (!launchers.has(it.parentToolCallId) || it.parentToolCallId === it.toolCallId) continue;
    const list = childrenOf.get(it.parentToolCallId) ?? [];
    list.push(it);
    childrenOf.set(it.parentToolCallId, list);
    nested.add(it.id);
  }

  const build = (call: ToolCallItem, seen: Set<string>): SubagentNode => {
    seen.add(call.toolCallId);
    const children: (ToolCallItem | SubagentNode)[] = [];
    let total = 0;
    for (const child of childrenOf.get(call.toolCallId) ?? []) {
      if (isLauncher(child) && launchers.has(child.toolCallId) && !seen.has(child.toolCallId)) {
        const node = build(child, seen);
        children.push(node);
        total += 1 + node.total;
      } else {
        children.push(child);
        total += 1;
      }
    }
    return { call, children, total };
  };

  const top: number[] = [];
  items.forEach((it, i) => {
    if (!(it.kind === "tool_call" && nested.has(it.id))) top.push(i);
  });
  const grouped = groupActivity(items, top, opts);

  const rows: Row[] = [];
  for (const i of grouped.rows) {
    const item = items[i];
    const members = grouped.groups.get(i);
    if (members) {
      rows.push({ kind: "group", key: item.id, items: members.map((m) => items[m]) });
    } else if (item.kind === "tool_call") {
      if (isLauncher(item) && launchers.has(item.toolCallId)) rows.push({ kind: "subagent", key: item.id, node: build(item, new Set()) });
      else rows.push({ kind: "tools", key: item.id, tools: [item] });
    } else rows.push({ kind: "item", key: item.id, item });
  }
  return rows;
}

/** A reply that is only pictures (empty text): never the turn's answer, and not a streaming text target. */
export const isPictureOnly = (it: TimelineItem | undefined): boolean =>
  !!it && it.kind === "agent_message" && !!it.images?.length && !it.text.trim();

/**
 * Ids of each turn's closing agent message (turns are delimited by user messages); every other
 * agent message is interim narration. A picture-only reply never replaces the text before it as
 * the turn's answer. Same rule as the desktop app's `finalAnswers`.
 */
export function finalAnswerIds(items: TimelineItem[]): Set<string> {
  const ids = new Set<string>();
  let last: string | null = null;
  for (const it of items) {
    if (it.kind === "user_message") {
      if (last) ids.add(last);
      last = null;
    } else if (it.kind === "agent_message" && !isPictureOnly(it)) last = it.id;
  }
  if (last) ids.add(last);
  return ids;
}

/** The most recent child activity of a sub-agent, for its collapsed card. */
export function latestChild(node: SubagentNode): ToolCallItem | null {
  for (let i = node.children.length - 1; i >= 0; i--) {
    const c = node.children[i];
    if (isSubagentNode(c)) return latestChild(c) ?? c.call;
    return c;
  }
  return null;
}

function sameNode(a: SubagentNode, b: SubagentNode): boolean {
  if (a.call !== b.call || a.children.length !== b.children.length) return false;
  for (let i = 0; i < a.children.length; i++) {
    const x = a.children[i];
    const y = b.children[i];
    if (isSubagentNode(x) || isSubagentNode(y)) {
      if (!isSubagentNode(x) || !isSubagentNode(y) || !sameNode(x, y)) return false;
    } else if (x !== y) return false;
  }
  return true;
}

/** Rows are rebuilt on every change; two rows are the same if they show the same item objects. */
export function sameRow(a: Row, b: Row): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.key !== b.key) return false;
  if (a.kind === "item") return a.item === (b as typeof a).item;
  if (a.kind === "tools") {
    const t = (b as typeof a).tools;
    return a.tools.length === t.length && a.tools.every((x, i) => x === t[i]);
  }
  if (a.kind === "group") {
    const t = (b as typeof a).items;
    return a.items.length === t.length && a.items.every((x, i) => x === t[i]);
  }
  return sameNode(a.node, (b as typeof a).node);
}

/** Rough row heights (incl. the 16px gap) before a row is measured; refined on mount. */
export function estimateRow(r: Row): number {
  if (r.kind === "tools") return 16 + 2 + r.tools.reduce((h, t) => h + 49 + (t.images?.length ? 108 : 0), 0);
  if (r.kind === "subagent") return 16 + 96;
  // Folded: groups only open when the reader opens them, and that row is measured at once.
  if (r.kind === "group") return 16 + 44;
  const it = r.item;
  const lines = (text: string, perLine: number) => Math.max(1, Math.ceil(text.length / perLine) + (text.match(/\n/g)?.length ?? 0) / 2);
  switch (it.kind) {
    case "user_message":
      return 16 + 24 + 23 * lines(it.text, 34) + (it.attachments?.length ? 104 : 0);
    case "agent_message":
      // Pictures in a reply show at their own size (up to 18rem tall), above any text.
      return 16 + (it.text ? 25 * lines(it.text, 42) + 40 * (it.text.split("```").length - 1) : 0) + (it.images?.length ? 8 + 200 : 0);
    case "thought":
      return 16 + 44;
    case "permission":
      return 16 + (it.resolution === null ? 330 : 52);
    case "question":
      return 16 + (it.resolution === null ? estimateQuestion(it) : 52 + 22 * summarize(it).length);
    case "plan":
      return 16 + 52 + 34 * it.entries.length;
    case "notice":
      return 16 + 30;
    case "turn_summary":
      return 16 + 190;
    default:
      return 60;
  }
}

/**
 * While an agent is interrupted the composer banner already says "Interrupted when Armada closed. Resume to
 * continue", so the timeline's own notice saying the same ("Armada closed while this agent was working. Resume
 * to pick up…") is dropped. Returns `items` itself when nothing is hidden.
 */
export function withoutResumeNotice(items: TimelineItem[], status: string): TimelineItem[] {
  if (status !== "interrupted") return items;
  const out = items.filter((it) => !(it.kind === "notice" && /\bresume\b/i.test(it.text)));
  return out.length === items.length ? items : out;
}
