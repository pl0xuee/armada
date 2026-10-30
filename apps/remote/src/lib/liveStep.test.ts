import { describe, expect, it } from "vitest";
import { liveStep, stepText } from "./liveStep";
import { THINKING_VERBS } from "./thinking";
import type { TimelineItem } from "./types";

let n = 0;
const base = () => ({ id: `i${n++}`, agentId: "a", seq: n, ts: n });
const tool = (extra: object = {}) =>
  ({ ...base(), kind: "tool_call", toolCallId: `t${n}`, title: "x", toolKind: "read", status: "in_progress", locations: [], diffs: [], output: "", command: null, ...extra }) as unknown as TimelineItem;
const user = () => ({ ...base(), kind: "user_message", text: "hi" }) as unknown as TimelineItem;
const msg = (text = "ok", images?: object[]) => ({ ...base(), kind: "agent_message", text, images }) as unknown as TimelineItem;
const thought = () => ({ ...base(), kind: "thought", text: "hm" }) as unknown as TimelineItem;
const summary = () => ({ ...base(), kind: "turn_summary" }) as unknown as TimelineItem;

const opts = { starting: false, name: "Claude", subagents: 0, verb: 0, offset: 0 };
const step = (items: TimelineItem[], o: Partial<typeof opts> = {}) => liveStep(items, { ...opts, ...o });

describe("liveStep", () => {
  it("names a running command, the command being the mono part", () => {
    expect(step([user(), tool({ toolKind: "execute", title: "Run tests", command: "npm test\n&& echo done" })])).toEqual({ kind: "command", text: "Running", code: "npm test" });
    expect(step([user(), tool({ toolKind: "execute", title: "Bash", command: null })])).toMatchObject({ code: "Bash" });
    expect(stepText(step([tool({ toolKind: "execute", command: "ls -la" })]))).toBe("Running ls -la");
  });
  it("names the file being read, edited, deleted or moved", () => {
    expect(step([tool({ toolKind: "read", locations: ["/p/src/foo.ts"] })]).text).toBe("Reading foo.ts");
    expect(step([tool({ toolKind: "edit", locations: ["/p/src/foo.ts"] })]).text).toBe("Editing foo.ts");
    expect(step([tool({ toolKind: "delete", locations: ["a/b.txt"] })]).text).toBe("Deleting b.txt");
    expect(step([tool({ toolKind: "move", locations: ["a/b.txt"] })]).text).toBe("Moving b.txt");
    expect(step([tool({ toolKind: "read", title: "Read file", locations: [] })]).text).toBe("Read file");
  });
  it("counts parallel unfinished calls of the same kind", () => {
    const edits = [tool({ toolKind: "edit", locations: ["a.ts"] }), tool({ toolKind: "edit", locations: ["b.ts"] })];
    expect(step(edits).text).toBe("Editing 2 files");
    expect(step([tool({ toolKind: "execute", command: "a" }), tool({ toolKind: "execute", command: "b" })]).text).toBe("Running 2 commands");
  });
  it("ignores finished calls and describes the newest unfinished one", () => {
    const items = [user(), tool({ toolKind: "read", locations: ["a.ts"] }), tool({ toolKind: "edit", locations: ["b.ts"] }), tool({ toolKind: "read", locations: ["c.ts"], status: "completed" })];
    expect(step(items).text).toBe("Editing b.ts");
    expect(step([tool({ toolKind: "edit", locations: ["b.ts"], status: "completed" })]).kind).toBe("verb");
  });
  it("names searches and fetches", () => {
    expect(step([tool({ toolKind: "search", title: 'Grep "foo bar"' })]).text).toBe("Searching for “foo bar”");
    expect(step([tool({ toolKind: "search", title: "Find files" })]).text).toBe("Searching");
    expect(step([tool({ toolKind: "fetch", title: "Fetch https://example.com/a/b?x=1" })]).text).toBe("Fetching example.com");
    expect(step([tool({ toolKind: "fetch", title: "Fetch" })]).text).toBe("Fetching a page");
  });
  it("says Thinking and Writing for the newest streaming item", () => {
    expect(step([user(), tool({ status: "completed" }), thought()])).toEqual({ kind: "thought", text: "Thinking…" });
    expect(step([user(), msg("partial")])).toEqual({ kind: "writing", text: "Writing…" });
    expect(step([user(), msg("")]).kind).toBe("writing");
  });
  it("does not treat a picture-only reply as text being written", () => {
    expect(step([user(), msg("", [{ name: "i.png" }])]).kind).toBe("verb");
  });
  it("skips a sub-agent's own calls and calls of earlier turns", () => {
    expect(step([tool({ toolKind: "execute", command: "old" }), summary(), user()]).kind).toBe("verb");
    expect(step([user(), tool({ toolKind: "execute", command: "child", parentToolCallId: "p" })]).kind).toBe("verb");
  });
  it("waits on sub-agents and starts up before anything else", () => {
    expect(step([tool({ toolKind: "execute", command: "x" })], { subagents: 2 })).toEqual({ kind: "subagents", text: "Waiting on 2 sub-agents" });
    expect(step([thought()], { starting: true, subagents: 2 })).toEqual({ kind: "starting", text: "Starting Claude" });
  });
  it("falls back to the cycling verbs", () => {
    expect(step([]).text).toBe(THINKING_VERBS[0]);
    expect(step([user()], { verb: 9 }).text).toBe(THINKING_VERBS[1]);
  });
});
