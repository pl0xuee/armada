import { describe, expect, it, vi } from "vitest";
import { renderToString } from "@/test/render";
import type { Attachment, TimelineItem } from "@/lib/types";

vi.mock("react", async (importOriginal) => {
  const m = await importOriginal<typeof import("react")>();
  return { ...m, memo: (c: unknown) => c, useState: (v: unknown) => [v, () => {}], useRef: (v: unknown) => ({ current: v }), useEffect: () => {} };
});
vi.mock("../Markdown", () => ({ Markdown: ({ text, caret, interim }: { text: string; caret?: boolean; interim?: boolean }) => <div data-md={text} data-caret={caret ? "1" : undefined} data-interim={interim ? "1" : undefined} /> }));
vi.mock("../Images", () => ({ ImageStrip: ({ images, large }: { images: Attachment[]; large?: boolean }) => <div data-strip={images.map((i) => i.name).join(",")} data-large={large ? "1" : undefined} /> }));
vi.mock("../LocalImage", () => ({ LocalImage: () => null }));
vi.mock("../CopyButton", () => ({ CopyButton: () => null }));
vi.mock("../Icon", () => ({ Icon: () => null, Spinner: () => null }));
vi.mock("@/lib/dev", () => ({ devParam: () => null }));
vi.mock("./DiffView", () => ({ DiffList: () => null }));

const { AgentMessage } = await import("./Items");

type Msg = Extract<TimelineItem, { kind: "agent_message" }>;
const png = (name: string): Attachment => ({ name, mimeType: "image/png", data: "AAAA" });
const msg = (text: string, images?: Attachment[]): Msg => ({ id: "m", agentId: "a", seq: 1, ts: 1, kind: "agent_message", text, images });
const render = (item: Msg, streaming = false, interim = false) => renderToString(<AgentMessage item={item} streaming={streaming} interim={interim} />);

describe("AgentMessage", () => {
  it("renders text only as before", () => {
    const out = render(msg("hello"));
    expect(out).toContain('data-md="hello"');
    expect(out).not.toContain("data-strip");
  });

  it("shows pictures above the text in a large strip", () => {
    const out = render(msg("see this", [png("a.png"), png("b.png")]));
    expect(out.indexOf("data-strip")).toBeLessThan(out.indexOf("data-md"));
    expect(out).toContain('data-strip="a.png,b.png"');
    expect(out).toContain('data-large="1"');
  });

  it("renders a picture-only reply as just the pictures: no empty bubble, no typing dots, no 'no reply'", () => {
    for (const streaming of [false, true]) {
      const out = render(msg("", [png("only.png")]), streaming);
      expect(out).toContain('data-strip="only.png"');
      expect(out).not.toContain("data-md");
      expect(out).not.toContain("Agent is working");
      expect(out).not.toContain("No reply");
    }
  });

  it("still shows typing dots while an empty text message streams, and a note once it ended empty", () => {
    expect(render(msg(""), true)).toContain("Agent is working");
    expect(render(msg(""), false)).toContain("No reply");
  });

  it("passes the interim flag to the text", () => {
    expect(render(msg("narration"), false, true)).toContain('data-interim="1"');
    expect(render(msg("answer"))).not.toContain("data-interim");
  });
});
