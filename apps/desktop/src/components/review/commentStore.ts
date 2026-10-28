import { create } from "zustand";
import { uuid } from "@/lib/utils";
import type { LineAnchor } from "../DiffView";

export interface LineComment extends LineAnchor {
  id: string;
  text: string;
}

interface CommentStore {
  /** Review comments per agent; kept while the app runs so closing the sheet doesn't lose them. */
  byAgent: Record<string, LineComment[]>;
  add: (agentId: string, anchor: LineAnchor, text: string) => void;
  update: (agentId: string, id: string, text: string) => void;
  remove: (agentId: string, id: string) => void;
  clear: (agentId: string) => void;
}

const EMPTY: LineComment[] = [];

export const useReviewComments = create<CommentStore>((set) => ({
  byAgent: {},
  add: (agentId, anchor, text) =>
    set((s) => ({
      byAgent: { ...s.byAgent, [agentId]: [...(s.byAgent[agentId] ?? EMPTY), { ...anchor, id: uuid(), text }] },
    })),
  update: (agentId, id, text) =>
    set((s) => ({
      byAgent: {
        ...s.byAgent,
        [agentId]: (s.byAgent[agentId] ?? EMPTY).map((c) => (c.id === id ? { ...c, text } : c)),
      },
    })),
  remove: (agentId, id) =>
    set((s) => ({ byAgent: { ...s.byAgent, [agentId]: (s.byAgent[agentId] ?? EMPTY).filter((c) => c.id !== id) } })),
  clear: (agentId) =>
    set((s) => {
      const byAgent = { ...s.byAgent };
      delete byAgent[agentId];
      return { byAgent };
    }),
}));

export function useAgentComments(agentId: string): LineComment[] {
  return useReviewComments((s) => s.byAgent[agentId] ?? EMPTY);
}

/** One prompt with every comment, in file order. */
export function formatReviewPrompt(comments: LineComment[]): string {
  const sorted = [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const lines = sorted.map((c) => {
    const where = `${c.path}:${c.line}${c.side === "old" ? " (removed line)" : ""}`;
    const code = c.code.trim();
    const quote = code ? ` — \`${code.length > 100 ? `${code.slice(0, 100)}…` : code}\`` : "";
    const body = c.text
      .trim()
      .split("\n")
      .map((t) => `  ${t}`)
      .join("\n");
    return `- \`${where}\`${quote}\n${body}`;
  });
  return `## Review comments\n\n${lines.join("\n")}\n\nPlease address these review comments.`;
}
