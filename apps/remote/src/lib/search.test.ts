import { describe, expect, it } from "vitest";
import { kindLabel, matchCount, resultGroups, searchText, splitSnippet } from "./search";
import type { Agent, SearchResults } from "./types";

describe("searchText", () => {
  it("waits for two characters and tidies blanks", () => {
    expect(searchText("")).toBeNull();
    expect(searchText("  a ")).toBeNull();
    expect(searchText("ab")).toBe("ab");
    expect(searchText("  token \n refresh ")).toBe("token refresh");
    expect(searchText("日本")).toBe("日本");
  });
});

describe("splitSnippet", () => {
  it("marks the matched words", () => {
    expect(splitSnippet("…fix the \u0001token\u0002 refresh \u0001race\u0002")).toEqual([
      { text: "…fix the ", hit: false },
      { text: "token", hit: true },
      { text: " refresh ", hit: false },
      { text: "race", hit: true },
    ]);
  });
  it("drops stray markers and copes with plain text", () => {
    expect(splitSnippet("plain")).toEqual([{ text: "plain", hit: false }]);
    expect(splitSnippet("\u0002a\u0002")).toEqual([{ text: "a", hit: false }]);
    expect(splitSnippet("")).toEqual([]);
  });
});

describe("resultGroups", () => {
  const agent = (id: string) => ({ id, title: id }) as Agent;
  const hit = (agentId: string) => ({ agentId, itemId: `${agentId}-1`, kind: "agent_message", snippet: "x", ts: 1, seq: 1 }) as never;
  const results: SearchResults = {
    groups: [
      { agentId: "b", hits: [hit("b")], total: 3 },
      { agentId: "gone", hits: [hit("gone")], total: 1 },
      { agentId: "a", hits: [hit("a")], total: 1 },
    ],
    indexing: false,
    truncated: false,
  };
  it("keeps the server's order and drops agents this phone doesn't have", () => {
    const groups = resultGroups(results, { a: agent("a"), b: agent("b") });
    expect(groups.map((g) => g.agent.id)).toEqual(["b", "a"]);
    expect(groups[0].group.total).toBe(3);
  });
  it("is empty without results", () => {
    expect(resultGroups(null, { a: agent("a") })).toEqual([]);
  });
});

describe("labels", () => {
  it("names a hit's kind", () => {
    expect(kindLabel("user_message")).toBe("you");
    expect(kindLabel("agent_message")).toBe("agent");
    expect(kindLabel("some_new_kind")).toBe("some new kind");
  });
  it("counts matches", () => {
    expect(matchCount(1)).toBe("1 match");
    expect(matchCount(4)).toBe("4 matches");
  });
});
