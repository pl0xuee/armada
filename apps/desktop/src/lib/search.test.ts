import { describe, expect, it } from "vitest";
import { searchItems } from "./mock-search";
import { plainSnippet, searchTerm, splitSnippet } from "./search";
import type { TimelineItem } from "./types";

const msg = (agentId: string, seq: number, text: string, kind: "user_message" | "agent_message" = "user_message") =>
  ({ id: `${agentId}-${seq}`, agentId, seq, ts: 1_700_000_000_000 + seq, kind, text }) as TimelineItem;

const tool = (agentId: string, seq: number, title: string, path: string, output = "") =>
  ({
    id: `${agentId}-${seq}`,
    agentId,
    seq,
    ts: 1_700_000_000_000 + seq,
    kind: "tool_call",
    toolCallId: `t${seq}`,
    title,
    toolKind: "edit",
    status: "completed",
    locations: [path],
    diffs: [],
    output,
    command: null,
  }) as TimelineItem;

describe("splitSnippet", () => {
  it("separates matched words from the rest", () => {
    expect(splitSnippet("fix the \u0001login\u0002 redirect")).toEqual([
      { text: "fix the ", hit: false },
      { text: "login", hit: true },
      { text: " redirect", hit: false },
    ]);
  });
  it("copes with no markers and with stray ones", () => {
    expect(splitSnippet("plain")).toEqual([{ text: "plain", hit: false }]);
    expect(splitSnippet("a\u0002b")).toEqual([
      { text: "a", hit: false },
      { text: "b", hit: false },
    ]);
    expect(splitSnippet("")).toEqual([]);
  });
  it("keeps astral characters whole", () => {
    expect(splitSnippet("\u0001🚀\u0002")).toEqual([{ text: "🚀", hit: true }]);
  });
  it("plainSnippet drops the markers", () => {
    expect(plainSnippet("a \u0001b\u0002 c")).toBe("a b c");
  });
});

describe("searchTerm", () => {
  it("drops the palette's search-mode prefix", () => {
    expect(searchTerm("? login bug")).toBe("login bug");
    expect(searchTerm("  ?login")).toBe("login");
    expect(searchTerm("login")).toBe("login");
  });
});

describe("searchItems (browser mock)", () => {
  const items = {
    a: [msg("a", 1, "Please fix the login redirect"), tool("a", 2, "Edit", "src/auth/session.ts", "secret")],
    b: [msg("b", 1, "Lunch plans"), msg("b", 2, "Reviewed the Login page", "agent_message")],
  };

  it("matches every word, the last as a prefix, case-insensitively", () => {
    const r = searchItems(items, "LOGIN redir");
    expect(r.groups.map((g) => g.agentId)).toEqual(["a"]);
    expect(searchItems(items, "login").groups.map((g) => g.agentId).sort()).toEqual(["a", "b"]);
    expect(searchItems(items, "redirect login").groups).toHaveLength(1);
  });

  it("finds file paths and tool names but not raw tool output", () => {
    expect(searchItems(items, "src/auth/session.ts").groups[0].hits[0].itemId).toBe("a-2");
    expect(searchItems(items, "session.ts").groups).toHaveLength(1);
    expect(searchItems(items, "secret").groups).toHaveLength(0);
  });

  it("marks the matches in the snippet", () => {
    const hit = searchItems(items, "redirect").groups[0].hits[0];
    expect(hit.snippet).toContain("\u0001redirect\u0002");
    expect(hit.seq).toBe(1);
  });

  it("returns nothing for nothing", () => {
    expect(searchItems(items, "  ").groups).toEqual([]);
    expect(searchItems(items, "---").groups).toEqual([]);
  });

  it("keeps the best few matches per conversation and counts the rest", () => {
    const many = { x: Array.from({ length: 8 }, (_, i) => msg("x", i + 1, `deploy step ${i + 1}`)) };
    const g = searchItems(many, "deploy").groups[0];
    expect(g.hits).toHaveLength(3);
    expect(g.total).toBe(8);
  });

  it("stays fast over a large history", () => {
    const words = ["parser", "cache", "retry", "socket", "config", "render", "schema", "deploy", "lint", "token"];
    const big: Record<string, TimelineItem[]> = {};
    for (let n = 0; n < 12_000; n++) {
      const id = `agent-${n % 60}`;
      (big[id] ??= []).push(
        msg(id, n, `${words[n % 10]} the ${words[(n >> 3) % 10]} and ${words[(n >> 5) % 10]} for ticket ${n}`),
      );
    }
    const started = performance.now();
    const common = searchItems(big, "retry sock");
    const rare = searchItems(big, "ticket 11999");
    const took = performance.now() - started;
    expect(common.groups.length).toBeGreaterThan(0);
    expect(rare.groups).toHaveLength(1);
    // Two searches over 12,000 items; the budget leaves room for a slow CI machine.
    expect(took).toBeLessThan(1500);
  });
});
