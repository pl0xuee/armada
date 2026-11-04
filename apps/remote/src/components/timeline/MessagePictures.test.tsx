import { describe, expect, it, vi } from "vitest";
import { renderToString } from "@/test/render";
import type { TimelineItem } from "@/lib/types";

vi.mock("react", async (importOriginal) => {
  const m = await importOriginal<typeof import("react")>();
  return { ...m, memo: (c: unknown) => c, useState: (v: unknown) => [v, () => {}], useRef: (v: unknown) => ({ current: v }), useEffect: () => {} };
});
vi.mock("../Markdown", () => ({ Markdown: () => null }));
vi.mock("../Images", () => ({ ImageStrip: () => null }));
vi.mock("../LocalImage", () => ({ LocalImage: () => null }));
vi.mock("../CopyButton", () => ({ CopyButton: () => null }));
vi.mock("../MessageFold", () => ({
  MessageFold: ({ canFold = true, children }: { canFold?: boolean; children: unknown }) => <div data-canfold={String(canFold)}>{children as never}</div>,
}));
vi.mock("../Icon", () => ({ Icon: () => null, Spinner: () => null }));
vi.mock("@/lib/dev", () => ({ devParam: () => null }));
vi.mock("./DiffView", () => ({ DiffList: () => null }));

const { AgentMessage } = await import("./Items");

type Msg = Extract<TimelineItem, { kind: "agent_message" }>;
const msg = (text: string): Msg => ({ id: "m", agentId: "a", seq: 1, ts: 1, kind: "agent_message", text });

describe("a reply with pictures", () => {
  it("never folds, even as a working note mid-turn", () => {
    const shots = "Here's where the game stands.\n\n**Title screen**\n![Title screen](/tmp/flow_title.png)\n\n**Hollowmere**\n![Walk](/tmp/flow_walk.png)";
    expect(renderToString(<AgentMessage item={msg(shots)} streaming={false} role="narration" />)).toContain('data-canfold="false"');
    expect(renderToString(<AgentMessage item={msg("![x](data:image/png;base64,iVBORw0KGgo=)")} streaming={false} />)).toContain('data-canfold="false"');
  });

  it("leaves other replies foldable", () => {
    expect(renderToString(<AgentMessage item={msg("Long words, [a link](https://example.com).")} streaming={false} role="narration" />)).toContain(
      'data-canfold="true"',
    );
  });
});
