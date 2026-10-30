import { describe, expect, it } from "vitest";
import { isLocalImagePath, markdownImagePath } from "./localImages";

describe("markdownImagePath", () => {
  it("keeps local paths", () => {
    expect(markdownImagePath("/home/me/shot.png")).toBe("/home/me/shot.png");
    expect(markdownImagePath("shots/a.png")).toBe("shots/a.png");
    expect(markdownImagePath("./a%20b.png")).toBe("./a b.png");
    expect(markdownImagePath("C:\\Users\\me\\a.png")).toBe("C:\\Users\\me\\a.png");
    expect(markdownImagePath("C:/Users/me/a.png")).toBe("C:/Users/me/a.png");
    expect(markdownImagePath("file:///home/me/a%20b.png")).toBe("/home/me/a b.png");
    expect(markdownImagePath("file:///C:/Users/me/a.png")).toBe("C:/Users/me/a.png");
    expect(markdownImagePath("file://localhost/home/me/a.png")).toBe("/home/me/a.png");
  });

  it("never fetches web, inline or other-scheme sources", () => {
    for (const s of ["https://x.test/a.png", "http://x.test/a.png", "data:image/png;base64,AAA", "blob:x", "ftp://x.test/a.png", "smb://x/s/a.png", "javascript:alert(1)", ""]) {
      expect(markdownImagePath(s)).toBeNull();
    }
  });

  it("rejects network paths", () => {
    for (const s of ["//evil.example/s/a.png", "\\\\evil.example\\s\\a.png", "%2F%2Fevil.example/s/a.png", "%5C%5Cevil.example%5Cs%5Ca.png", "file://evil.example/s/a.png", "file:////evil.example/s/a.png"]) {
      expect(markdownImagePath(s)).toBeNull();
    }
  });
});

describe("isLocalImagePath", () => {
  it("accepts absolute image paths only", () => {
    expect(isLocalImagePath("/tmp/a.png")).toBe(true);
    expect(isLocalImagePath("C:\\a.png")).toBe(true);
    expect(isLocalImagePath("//evil/a.png")).toBe(false);
    expect(isLocalImagePath("/tmp/a.txt")).toBe(false);
  });
});
