import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn with the type-step tokens", () => {
  it("lets a later size replace an earlier one", () => {
    expect(cn("h-8 text-body", "text-caption")).toBe("h-8 text-caption");
    expect(cn("text-micro", "text-[14px]")).toBe("text-[14px]");
    expect(cn("text-small", "text-xs")).toBe("text-xs");
  });

  it("keeps a colour next to a size", () => {
    expect(cn("text-micro text-steel")).toBe("text-micro text-steel");
    expect(cn("text-caption", "text-err-fg")).toBe("text-caption text-err-fg");
  });
});
