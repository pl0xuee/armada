import { describe, expect, it } from "vitest";
import { backgroundOf, backgroundPill } from "./background";

describe("the header pill for background agents", () => {
  it("stays short enough to sit beside the header controls", () => {
    expect(backgroundPill(backgroundOf(0, 0, 0, 4))).toBe("Turn finished · 4 agents may be running");
    expect(backgroundPill(backgroundOf(0, 0, 0, 1))).toBe("Turn finished · 1 agent may be running");
  });
});
