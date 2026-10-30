import { describe, expect, it } from "vitest";
import { groupActivity, openGroupKeys, summarizeActivity } from "./activity";
import type { TimelineItem } from "./types";

let n = 0;
const base = () => ({ id: `i${n++}`, ts: 0 });
const tool = (extra: object = {}) =>
  ({ ...base(), kind: "tool_call", toolCallId: `t${n}`, title: "x", toolKind: "read", status: "completed", locations: [], diffs: [], output: "", command: null, ...extra }) as unknown as TimelineItem;
const user = () => ({ ...base(), kind: "user_message", text: "hi" }) as unknown as TimelineItem;
const msg = (text = "ok") => ({ ...base(), kind: "agent_message", text }) as unknown as TimelineItem;
const pic = () => ({ ...base(), kind: "agent_message", text: "", images: [{ name: "i.png", mimeType: "image/png", data: "AAAA" }] }) as unknown as TimelineItem;
const thought = () => ({ ...base(), kind: "thought", text: "hm" }) as unknown as TimelineItem;
const perm = (resolution: string | null) =>
  ({ ...base(), kind: "permission", requestId: "r", title: "p", toolKind: null, command: null, diffs: [], options: [], resolution }) as unknown as TimelineItem;

const run = (items: TimelineItem[]) =>
  groupActivity(
    items,
    items.map((_, i) => i),
  );

describe("groupActivity", () => {
  it("groups a run of tool calls and thoughts", () => {
    const g = run([user(), tool(), thought(), tool(), msg()]);
    expect(g.rows).toEqual([0, 1, 4]);
    expect(g.groups.get(1)).toEqual([1, 2, 3]);
  });
  it("never folds agent messages: what the agent says stays where it is", () => {
    const g = run([user(), tool(), msg(), tool(), msg()]);
    expect(g.groups.size).toBe(0);
    expect(g.rows).toEqual([0, 1, 2, 3, 4]);
  });
  it("a message splits runs, and each run keeps its own group while later calls stream in", () => {
    const g = run([user(), tool(), tool(), msg(), tool(), tool()]);
    expect(g.rows).toEqual([0, 1, 3, 4]);
    expect(g.groups.get(1)).toEqual([1, 2]);
    expect(g.groups.get(4)).toEqual([4, 5]);
  });
  it("a pending permission breaks the run", () => {
    const g = run([user(), tool(), tool(), perm(null), tool(), tool()]);
    expect(g.rows).toEqual([0, 1, 3, 4]);
  });
  it("a sub-agent launch breaks the run, but a control call doesn't", () => {
    expect(run([tool(), tool(), tool({ subagent: { kind: "a" } }), tool(), tool()]).rows).toEqual([0, 2, 3]);
    const g = run([tool(), tool({ subagent: { kind: "wait", control: true } }), tool()]);
    expect(g.groups.get(0)).toEqual([0, 1, 2]);
  });
  it("does not group a single item", () => {
    const g = run([user(), tool(), msg()]);
    expect(g.groups.size).toBe(0);
    expect(g.rows).toEqual([0, 1, 2]);
  });
  it("a run only ever grows: the rows before it never change when more calls arrive", () => {
    const items = [user(), tool(), tool(), msg(), tool()];
    const before = run(items);
    const after = run([...items, tool()]);
    expect(before.rows).toEqual([0, 1, 3, 4]);
    expect(after.rows).toEqual([0, 1, 3, 4]);
    expect(after.groups.get(1)).toEqual(before.groups.get(1));
    expect(after.groups.get(4)).toEqual([4, 5]);
  });
  it("keeps pictures and their text in view", () => {
    const g = run([user(), tool(), tool(), pic(), tool(), tool(), msg()]);
    expect(g.rows.includes(3)).toBe(true);
    for (const members of g.groups.values()) expect(members.includes(3)).toBe(false);
  });
});

describe("summarizeActivity", () => {
  it("counts by kind, in the desktop's wording", () => {
    const items = [tool(), tool(), tool({ toolKind: "edit" }), tool({ toolKind: "execute" }), tool({ toolKind: "execute", status: "failed" }), tool({ toolKind: "search" }), thought()];
    expect(summarizeActivity(items)).toEqual({ text: "Read 2 files, edited 1 file, ran 2 commands, 1 search", failed: 1 });
    expect(summarizeActivity([tool({ toolKind: "fetch" }), tool({ toolKind: "other" })]).text).toBe("Fetched 1 page, 1 other tool");
    expect(summarizeActivity([tool({ toolKind: "other" }), tool({ toolKind: "other" })]).text).toBe("Used 2 tools");
    expect(summarizeActivity([tool({ toolKind: "search" })]).text).toBe("Ran 1 search");
    expect(summarizeActivity([tool({ toolKind: "search" }), tool({ toolKind: "search" }), tool({ toolKind: "read" })]).text).toBe("Read 1 file, ran 2 searches");
    expect(summarizeActivity([tool({ toolKind: "execute" }), tool({ toolKind: "search" }), tool({ toolKind: "other" })]).text).toBe("Ran 1 command, 1 search, 1 other tool");
  });
  it("describes groups without tool calls", () => {
    expect(summarizeActivity([thought(), msg()]).text).toBe("Thought for a moment");
    expect(summarizeActivity([msg(), msg()]).text).toBe("2 steps");
  });
});

describe("openGroupKeys", () => {
  const g = (key: string, ...ids: string[]) => ({ kind: "group", key, items: [key, ...ids].map((id) => ({ id })) });
  it("opens nothing unless the reader opened it", () => {
    expect(openGroupKeys([g("a", "a2")], new Set()).size).toBe(0);
  });
  it("keeps an opened group open when runs merge and its key changes", () => {
    const merged = g("a", "a2", "k", "b", "b2"); // "b" was the opened group before the run merged into "a"
    expect([...openGroupKeys([merged], new Set(["b"]))]).toEqual(["a"]);
    expect([...openGroupKeys([{ kind: "item", key: "x" }, g("a", "a2"), g("c", "c2")], new Set(["c"]))]).toEqual(["c"]);
  });
});
