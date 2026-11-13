import { describe, expect, it } from "vitest";
import type { TimelineItem } from "@/lib/types";
import { applyFolds, isStep, summarizeFold, turnFolds } from "./turnFold";
import { turnFileStats } from "./turnFiles";

let n = 0;
const base = () => ({ id: `i${n++}`, ts: 0 });
const tool = (extra: object = {}) =>
  ({
    ...base(),
    kind: "tool_call",
    toolCallId: `t${n}`,
    title: "x",
    toolKind: "read",
    status: "completed",
    locations: [],
    diffs: [],
    output: "",
    command: null,
    ...extra,
  }) as unknown as TimelineItem;
const user = (midTurn = false) => ({ ...base(), kind: "user_message", text: "hi", midTurn }) as unknown as TimelineItem;
const msg = () => ({ ...base(), kind: "agent_message", text: "ok" }) as unknown as TimelineItem;
const pic = () =>
  ({
    ...base(),
    kind: "agent_message",
    text: "",
    images: [{ name: "i.png", mimeType: "image/png", data: "AAAA" }],
  }) as unknown as TimelineItem;
const thought = () => ({ ...base(), kind: "thought", text: "hm" }) as unknown as TimelineItem;
const perm = (resolution: string | null, plan = false) =>
  ({
    ...base(),
    kind: "permission",
    requestId: "r",
    title: "p",
    toolKind: null,
    command: null,
    diffs: [],
    options: [],
    resolution,
    ...(plan ? { plan: "the plan" } : {}),
  }) as unknown as TimelineItem;
const summary = (durationMs: number, files: string[] = []) =>
  ({
    ...base(),
    kind: "turn_summary",
    durationMs,
    files,
    toolCalls: 0,
    commands: 0,
    costUsd: 0,
    tokens: 0,
  }) as unknown as TimelineItem;
const notice = () => ({ ...base(), kind: "notice", level: "info", text: "n" }) as unknown as TimelineItem;

/** Folds of a plain list (every item its own row); `finals` are indices of the answers. */
const folds = (items: TimelineItem[], finals: number[]) =>
  turnFolds(
    items,
    items.map((_, i) => i),
    new Set(finals),
  );

describe("isStep", () => {
  it("counts the work and leaves the conversation alone", () => {
    expect(isStep(tool(), false)).toBe(true);
    expect(isStep(thought(), false)).toBe(true);
    expect(isStep(msg(), false)).toBe(true);
    expect(isStep(msg(), true)).toBe(false);
    expect(isStep(pic(), false)).toBe(false);
    expect(isStep(user(), false)).toBe(false);
    expect(isStep(notice(), false)).toBe(false);
  });

  it("folds an answered approval, never a pending one or an answered plan", () => {
    expect(isStep(perm("allow"), false)).toBe(true);
    expect(isStep(perm(null), false)).toBe(false);
    expect(isStep(perm("allow", true), false)).toBe(false);
  });
});

describe("turnFolds", () => {
  it("folds a turn's steps up to its answer, with the turn's duration", () => {
    const items = [user(), thought(), tool(), msg(), tool(), msg(), summary(242_000)];
    const f = folds(items, [5]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ first: 1, rows: [1, 2, 3, 4], latest: true, durationMs: 242_000 });
  });

  it("marks only the latest turn as latest", () => {
    const items = [user(), tool(), msg(), user(), tool(), msg()];
    const f = folds(items, [2, 5]);
    expect(f.map((x) => [x.first, x.latest])).toEqual([
      [1, false],
      [4, true],
    ]);
  });

  it("leaves what the agent did after its answer as it is", () => {
    const items = [user(), tool(), msg(), tool(), tool()];
    const f = folds(items, [2]);
    expect(f).toHaveLength(1);
    expect(f[0].rows).toEqual([1]);
  });

  it("splits on what stays in view, and gives the time to the turn's first fold only", () => {
    const items = [user(), tool(), pic(), tool(), tool(), msg(), summary(9000)];
    const f = folds(items, [5]);
    expect(f.map((x) => x.rows)).toEqual([[1], [3, 4]]);
    expect(f.map((x) => x.durationMs)).toEqual([9000, null]);
  });

  it("splits but does not end a turn on a message sent into it", () => {
    const items = [user(), tool(), user(true), tool(), msg(), summary(5000)];
    const f = folds(items, [4]);
    expect(f.map((x) => x.rows)).toEqual([[1], [3]]);
    expect(f[0].durationMs).toBe(5000);
    expect(f.every((x) => x.latest)).toBe(true);
  });

  it("has no time to give when the turn has no summary", () => {
    const items = [user(), tool(), msg()];
    expect(folds(items, [2])[0].durationMs).toBeNull();
  });

  it("folds nothing in a turn without steps", () => {
    expect(folds([user(), msg()], [1])).toEqual([]);
  });
});

describe("applyFolds", () => {
  const items = [user(), tool(), tool(), msg(), user(), tool(), msg()];
  const rows = items.map((_, i) => i);
  const f = turnFolds(items, rows, new Set([3, 6]));

  it("hides a closed fold's steps behind its first row", () => {
    const r = applyFolds(rows, f, () => false, false);
    expect(r.rows).toEqual([0, 1, 3, 4, 5, 6]);
    expect([...r.heads.keys()]).toEqual([1, 5]);
    expect(r.hidden.get(2)).toBe(1);
    expect(r.steps.size).toBe(0);
  });

  it("shows an open fold's steps as steps", () => {
    const r = applyFolds(rows, f, (first) => first === 1, false);
    expect(r.rows).toEqual(rows);
    expect([...r.steps]).toEqual([1, 2]);
  });

  it("keeps a running turn live", () => {
    const r = applyFolds(rows, f, () => false, true);
    expect([...r.heads.keys()]).toEqual([1]);
    expect(r.rows).toEqual([0, 1, 3, 4, 5, 6]);
  });
});

describe("summarizeFold", () => {
  it("says what the steps were, naming the noun once", () => {
    const s = summarizeFold([
      tool(),
      tool(),
      tool({ toolKind: "edit" }),
      tool({ toolKind: "execute", status: "failed" }),
      thought(),
    ]);
    expect(s).toEqual({ text: "read 2 files · edited 1 · ran 1 command", steps: 5, failed: 1 });
    expect(summarizeFold([tool({ toolKind: "edit" })]).text).toBe("edited 1 file");
  });
});

describe("turnFileStats", () => {
  const diff = (path: string, unified: string) => ({ path, oldText: null, newText: null, unified });

  it("adds up the turn's own edits per changed file", () => {
    const items = [
      user(),
      tool({ toolKind: "edit", diffs: [diff("/repo/src/old.ts", "+a\n")] }),
      msg(),
      user(),
      tool({ toolKind: "edit", diffs: [diff("/repo/src/a.ts", "+a\n+b\n-c\n")] }),
      tool({ toolKind: "edit", diffs: [diff("src/a.ts", "+d\n"), diff("/repo/src/old.ts", "-x\n")] }),
      msg(),
      summary(1000, ["src/a.ts", "src/b.ts"]),
    ];
    const s = turnFileStats(items, items[7].id, ["src/a.ts", "src/b.ts"]);
    expect(s.get("src/a.ts")).toEqual({ additions: 3, deletions: 1 });
    // No edit named it: its counts are not known.
    expect(s.has("src/b.ts")).toBe(false);
    expect(s.size).toBe(1);
  });
});
