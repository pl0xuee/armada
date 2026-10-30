import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "@/test/render";
import type { RunningSubagent } from "@/lib/subagents";
import type { TimelineItem } from "@/lib/types";

vi.mock("react", async (importOriginal) => {
  const m = await importOriginal<typeof import("react")>();
  return {
    ...m,
    memo: (c: unknown) => c,
    useState: (v: unknown) => [v, () => {}],
    useRef: (v: unknown) => ({ current: v }),
    useEffect: () => {},
  };
});
vi.mock("../Icon", () => ({ Icon: ({ name }: { name: string }) => <i data-icon={name} /> }));
vi.mock("./Items", () => ({ TypingDots: () => <i data-dots /> }));

const { LiveStatus } = await import("./LiveStatus");

const NOW = 1_700_000_000_000;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const cmd = (command: string): TimelineItem =>
  ({ id: "t", agentId: "a", seq: 1, ts: NOW, kind: "tool_call", toolCallId: "tc", title: "Run", toolKind: "execute", status: "in_progress", locations: [], diffs: [], output: "", command }) as TimelineItem;

const agent = {
  status: "working" as const,
  model: null,
  configOptions: [
    { id: "model", name: "Model", category: "model", currentValue: "opus", options: [{ value: "opus", name: "Opus", description: null }] },
    { id: "effort", name: "Reasoning", category: "thought_level", currentValue: "high", options: [{ value: "high", name: "High", description: null }] },
  ],
};

const sub = (extra: Partial<RunningSubagent> = {}): RunningSubagent => ({
  id: "s1",
  kind: "Explore",
  description: "Find where the router is defined",
  model: null,
  effort: null,
  startedAt: NOW - 95_000,
  toolCalls: 3,
  ...extra,
});

const render = (p: Partial<Parameters<typeof LiveStatus>[0]> = {}) =>
  renderToString(<LiveStatus agent={agent} name="Claude" items={[]} subagents={0} running={[]} since={0} open={false} onToggle={() => {}} {...p} />);

describe("LiveStatus", () => {
  it("is one fixed-height status line with dots and the current step", () => {
    const out = render({ items: [cmd("npm test")] });
    expect(out).toContain("<div role=\"status\">");
    expect(out).toContain("h-9");
    expect(out).toContain("data-dots");
    expect(out).toContain("Running");
    expect(out).toContain('<code class="font-mono text-[12.5px] text-muted">npm test</code>');
    expect(out).toContain("truncate");
    expect(out).not.toContain("<button");
  });

  it("shows elapsed time only after the threshold", () => {
    expect(render({ since: NOW - 1_000 })).not.toContain("·");
    expect(render({ since: NOW - 65_000 })).toContain("· 1m 05s");
  });

  it("reads Waiting on N sub-agents and is a tappable, collapsed button", () => {
    const out = render({ subagents: 2, running: [sub(), sub({ id: "s2" })] });
    expect(out).toContain("Waiting on 2 sub-agents");
    expect(out).toContain("<button");
    expect(out).toContain("hit");
    expect(out).not.toContain("aria-expanded");
    expect(out).not.toContain("Explore");
  });

  it("is not tappable when there is nothing to list", () => {
    const out = render({ subagents: 1, running: [] });
    expect(out).toContain("Waiting on 1 sub-agent");
    expect(out).not.toContain("<button");
  });

  it("expands to each running sub-agent: kind, task, chips, elapsed and tool calls", () => {
    const out = render({
      subagents: 2,
      open: true,
      running: [sub({ model: "haiku", effort: "low" }), sub({ id: "s2", kind: "general-purpose", description: "Fix it", toolCalls: 1, startedAt: NOW - 5_000 })],
    });
    expect(out).toMatch(/aria-expanded[ >]/);
    expect(out).toContain("Explore");
    expect(out).toContain("Find where the router is defined");
    expect(out).toContain(">haiku<");
    expect(out).toContain(">low effort<");
    expect(out).toContain("1m 35s · 3 tool calls");
    expect(out).toContain("general-purpose");
    // The second names nothing: it inherits the main agent's.
    expect(out).toContain("inherits Opus");
    expect(out).toContain("inherits High effort");
    expect(out).toContain("5s · 1 tool call<");
  });

  it("omits chips it cannot know instead of inventing them", () => {
    const out = render({ agent: { status: "working", model: null, configOptions: [] }, subagents: 1, open: true, running: [sub()] });
    expect(out).not.toContain("inherits");
    expect(out).toContain("3 tool calls");
  });

  it("stays closed when asked to be, even with sub-agents running", () => {
    expect(render({ subagents: 1, running: [sub()], open: false })).not.toContain("Find where");
  });
});
