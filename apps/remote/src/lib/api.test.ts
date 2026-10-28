import { describe, expect, it } from "vitest";
import { SseParser } from "./api";

describe("SseParser", () => {
  it("handles chunk boundaries, CRLF, comments and multi-line data", () => {
    const got: string[] = [];
    const p = new SseParser((d) => got.push(d));
    p.push(": heartbeat\n\nda");
    p.push('ta: {"type":"resync"}\r');
    p.push("\n\r\ndata: a\ndata: b\n\n: ping\n\ndata:no-space\n\n");
    expect(got).toEqual(['{"type":"resync"}', "a\nb", "no-space"]);
  });
  it("ignores event/id fields and incomplete trailing events", () => {
    const got: string[] = [];
    const p = new SseParser((d) => got.push(d));
    p.push("event: x\nid: 7\ndata: 1\n\ndata: partial");
    expect(got).toEqual(["1"]);
  });
});
