import { describe, expect, it } from "vitest";
import { denyThenSend } from "./denyReason";

describe("denyThenSend", () => {
  it("denies first, then sends the trimmed reason", async () => {
    const calls: string[] = [];
    const ok = await denyThenSend(
      "  use the SQL file instead \n",
      async () => (calls.push("deny"), true),
      async (t) => void calls.push(`send:${t}`),
    );
    expect(ok).toBe(true);
    expect(calls).toEqual(["deny", "send:use the SQL file instead"]);
  });
  it("does not send the reason when the deny failed", async () => {
    const calls: string[] = [];
    const ok = await denyThenSend(
      "reason",
      async () => (calls.push("deny"), false),
      async () => void calls.push("send"),
    );
    expect(ok).toBe(false);
    expect(calls).toEqual(["deny"]);
  });
  it("does nothing for an empty reason", async () => {
    const calls: string[] = [];
    expect(await denyThenSend("   ", async () => (calls.push("deny"), true), async () => void calls.push("send"))).toBe(false);
    expect(calls).toEqual([]);
  });
});
