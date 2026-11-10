import { describe, expect, it } from "vitest";
import { getDraftAttachments, setDraftAttachments } from "./drafts";

const pic = (name: string) => ({ name, mimeType: "image/png", data: "AAAA" });

describe("pictures waiting in an agent's message box", () => {
  it("are kept per agent and dropped once sent", () => {
    setDraftAttachments("a", [pic("one.png")]);
    expect(getDraftAttachments("a").map((p) => p.name)).toEqual(["one.png"]);
    expect(getDraftAttachments("b")).toEqual([]);
    setDraftAttachments("a", []);
    expect(getDraftAttachments("a")).toEqual([]);
  });

  it("keeps only the most recent few agents", () => {
    for (let i = 0; i < 20; i++) setDraftAttachments(`many-${i}`, [pic("p.png")]);
    expect(getDraftAttachments("many-0")).toEqual([]);
    expect(getDraftAttachments("many-19")).toHaveLength(1);
  });
});
