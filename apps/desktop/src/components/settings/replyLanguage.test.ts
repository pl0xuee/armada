import { describe, expect, it } from "vitest";
import { LANGUAGES } from "@/lib/languages";

describe("reply languages", () => {
  it("are unique, named in English, and never the empty value a select item can't hold", () => {
    expect(new Set(LANGUAGES).size).toBe(LANGUAGES.length);
    expect(LANGUAGES.every((l) => l.trim() === l && l.length > 0)).toBe(true);
    expect(LANGUAGES).toContain("English");
    expect(LANGUAGES as readonly string[]).not.toContain("match");
  });
});
