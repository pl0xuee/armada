import { describe, expect, it, vi } from "vitest";
import { renderToString } from "@/test/render";
import type { ToolCallItem } from "@/lib/types";

vi.mock("react", async (importOriginal) => {
  const m = await importOriginal<typeof import("react")>();
  return {
    ...m,
    memo: (c: unknown) => c,
    useState: (v: unknown) => [v, () => {}],
    useRef: (v: unknown) => ({ current: v }),
    useMemo: (f: () => unknown) => f(),
    useEffect: () => {},
  };
});
vi.mock("../Markdown", () => ({ Markdown: () => null }));
vi.mock("../Images", () => ({ ImageStrip: () => null }));
vi.mock("../LocalImage", () => ({ LocalImage: () => null }));
vi.mock("../CopyButton", () => ({ CopyButton: () => null }));
vi.mock("../Icon", () => ({
  Icon: ({ name }: { name: string }) => <i data-icon={name} />,
  Spinner: () => <i data-spinner />,
}));
vi.mock("@/lib/dev", () => ({ devParam: () => null }));
vi.mock("./DiffView", () => ({ DiffList: () => <div data-diff /> }));

const { ToolRow } = await import("./Items");

// Unique ids: a command that opened itself while running is remembered by id for the whole session.
let seq = 0;
const tool = (extra: Partial<ToolCallItem> = {}): ToolCallItem => ({
  id: `t${++seq}`,
  agentId: "a",
  seq: 1,
  ts: 1,
  kind: "tool_call",
  toolCallId: "tc",
  title: "Run tests",
  toolKind: "execute",
  status: "completed",
  locations: [],
  diffs: [],
  output: "",
  command: "npm test",
  ...extra,
});

// The test renderer prints a true attribute bare and omits a false one.
const OPEN = /aria-expanded[ >]/;

describe("ToolRow", () => {
  it("cleans ANSI escapes and progress-bar redraws out of the output", () => {
    const out = renderToString(<ToolRow item={tool({ status: "failed", output: "\x1b[31mFAIL\x1b[0m\nloading 10%\rloading 100%\nexit code 1" })} />);
    expect(out).toContain("FAIL");
    expect(out).toContain("loading 100%");
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("loading 10%");
  });

  it("opens a failed call by default and shows the exit code badge", () => {
    const out = renderToString(<ToolRow item={tool({ status: "failed", output: "boom\nexit code 2" })} />);
    expect(out).toContain("exit 2");
    expect(out).toMatch(OPEN);
    expect(out).toContain("npm test");
  });

  it("keeps a finished, successful call closed", () => {
    const out = renderToString(<ToolRow item={tool({ output: "ok" })} />);
    expect(out).not.toMatch(OPEN);
    expect(out).not.toContain("npm test");
  });

  it("opens a running command with its live output", () => {
    const out = renderToString(<ToolRow item={tool({ status: "in_progress", output: "step 1" })} />);
    expect(out).toMatch(OPEN);
    expect(out).toContain("Live");
    expect(out).toContain("step 1");
    expect(out).toContain("data-spinner");
  });

  it("remembers that a command opened itself while running, across the row being unmounted and remounted", () => {
    const running = tool({ status: "in_progress", output: "step 1" });
    expect(renderToString(<ToolRow item={running} />)).toMatch(OPEN);
    // The virtual list unmounted the row; it comes back finished: still open (no height jump).
    const done = renderToString(<ToolRow item={{ ...running, status: "completed", output: "done" }} />);
    expect(done).toMatch(OPEN);
    expect(done).toContain("done");
    // Another finished command that never ran in view stays closed.
    expect(renderToString(<ToolRow item={tool({ output: "ok" })} />)).not.toMatch(OPEN);
  });

  it("shows an unfinished call of a stopped agent as paused, not spinning", () => {
    const out = renderToString(<ToolRow item={tool({ status: "in_progress", output: "step 1" })} agentLive={false} />);
    expect(out).toContain('aria-label="Paused"');
    expect(out).not.toContain("data-spinner");
    expect(out).not.toContain("Live");
    expect(out).not.toMatch(OPEN);
  });

  it("shows +/- line counts for edits", () => {
    const diffs = [{ path: "a.ts", oldText: "a\nb\n", newText: "a\nc\nd\n", unified: null }];
    const out = renderToString(<ToolRow item={tool({ toolKind: "edit", title: "Edit a.ts", command: null, diffs })} />);
    expect(out).toContain("+2");
    expect(out).toContain("−1");
  });
});
