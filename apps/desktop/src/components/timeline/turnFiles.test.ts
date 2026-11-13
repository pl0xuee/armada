import { describe, expect, it } from "vitest";
import { fileFor } from "./turnFiles";

describe("fileFor (which changed file an edit belongs to)", () => {
  const files = ["src/index.ts", "lib/src/index.ts"];

  it("prefers an exact match", () => {
    expect(fileFor(files, "src/index.ts")).toBe("src/index.ts");
  });

  it("takes the closest file for a full path, not the first that fits", () => {
    expect(fileFor(files, "/repo/lib/src/index.ts")).toBe("lib/src/index.ts");
    expect(fileFor(files, "/repo/src/index.ts")).toBe("src/index.ts");
  });

  it("matches a short path to the nearest full one, and nothing to an unrelated file", () => {
    expect(fileFor(["/repo/src/a.ts", "/repo/pkg/src/a.ts"], "src/a.ts")).toBe("/repo/src/a.ts");
    expect(fileFor(files, "index.tsx")).toBeUndefined();
    expect(fileFor(files, "/repo/xsrc/index.ts")).toBeUndefined();
  });
});
