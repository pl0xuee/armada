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

const { ToolRow, OutputBlock } = await import("./Items");

// Unique ids per test.
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
    const out = renderToString(<OutputBlock text={"\x1b[31mFAIL\x1b[0m\nloading 10%\rloading 100%\nexit code 1"} />);
    expect(out).toContain("FAIL");
    expect(out).toContain("loading 100%");
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("loading 10%");
  });

  it("keeps a failed call closed, with the exit code badge on its row", () => {
    const out = renderToString(<ToolRow item={tool({ status: "failed", output: "boom\nexit code 2" })} />);
    expect(out).toContain("exit 2");
    expect(out).not.toMatch(OPEN);
    expect(out).not.toContain("npm test");
  });

  it("finds the exit code inside the fence the Bash tool wraps its output in", () => {
    const out = renderToString(<ToolRow item={tool({ status: "failed", output: "```console\nboom\nexit code 3\n```" })} />);
    expect(out).toContain("exit 3");
  });

  it("keeps a finished, successful call closed", () => {
    const out = renderToString(<ToolRow item={tool({ output: "ok" })} />);
    expect(out).not.toMatch(OPEN);
    expect(out).not.toContain("npm test");
  });

  it("keeps a running command closed and shows its newest output line in the row", () => {
    const out = renderToString(<ToolRow item={tool({ status: "in_progress", output: "```console\nstep 1\n\nstep 2  \n" })} />);
    expect(out).not.toMatch(OPEN);
    expect(out).toContain("step 2");
    expect(out).not.toContain("step 1");
    expect(out).not.toContain("```");
    expect(out).toContain("data-spinner");
  });

  it("does not show an output line for a finished command", () => {
    const out = renderToString(<ToolRow item={tool({ output: "all done" })} />);
    expect(out).not.toContain("all done");
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
