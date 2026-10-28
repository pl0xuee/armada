/**
 * Turns a flat timeline into display rows: consecutive tool calls stack into
 * one card, and calls that ran under a sub-agent are nested under the call
 * that launched it (recursively), instead of interleaving with the main flow.
 */
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
  | { kind: "subagent"; key: string; node: SubagentNode };

export const isRunning = (c: ToolCallItem) => c.status === "pending" || c.status === "in_progress";

export function isSubagentNode(x: ToolCallItem | SubagentNode): x is SubagentNode {
  return "call" in x;
}

export function buildRows(items: TimelineItem[]): Row[] {
  // Sub-agent launchers by their tool call id.
  const launchers = new Map<string, ToolCallItem>();
  for (const it of items) if (it.kind === "tool_call" && it.subagent && it.toolCallId) launchers.set(it.toolCallId, it);

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
      if (child.subagent && launchers.has(child.toolCallId) && !seen.has(child.toolCallId)) {
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

  const rows: Row[] = [];
  for (const item of items) {
    if (item.kind === "tool_call") {
      if (nested.has(item.id)) continue;
      if (item.subagent && launchers.has(item.toolCallId)) {
        rows.push({ kind: "subagent", key: item.id, node: build(item, new Set()) });
        continue;
      }
      const last = rows[rows.length - 1];
      if (last && last.kind === "tools") last.tools.push(item);
      else rows.push({ kind: "tools", key: item.id, tools: [item] });
      continue;
    }
    rows.push({ kind: "item", key: item.id, item });
  }
  return rows;
}

/** Sub-agents that are still working (for the header badge). */
export function runningSubagents(items: TimelineItem[]): number {
  let n = 0;
  for (const it of items) if (it.kind === "tool_call" && it.subagent && isRunning(it)) n++;
  return n;
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
  return sameNode(a.node, (b as typeof a).node);
}

/** Rough row heights (incl. the 16px gap) before a row is measured; refined on mount. */
export function estimateRow(r: Row): number {
  if (r.kind === "tools") return 16 + 2 + r.tools.reduce((h, t) => h + 49 + (t.images?.length ? 108 : 0), 0);
  if (r.kind === "subagent") return 16 + 96;
  const it = r.item;
  const lines = (text: string, perLine: number) => Math.max(1, Math.ceil(text.length / perLine) + (text.match(/\n/g)?.length ?? 0) / 2);
  switch (it.kind) {
    case "user_message":
      return 16 + 24 + 23 * lines(it.text, 34) + (it.attachments?.length ? 104 : 0);
    case "agent_message":
      return 16 + 25 * lines(it.text, 42) + 40 * (it.text.split("```").length - 1);
    case "thought":
      return 16 + 44;
    case "permission":
      return 16 + (it.resolution === null ? 330 : 52);
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
