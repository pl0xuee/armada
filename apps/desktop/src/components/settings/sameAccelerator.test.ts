import { describe, expect, it } from "vitest";
import { sameAccelerator } from "./acceleratorLabels";

describe("sameAccelerator", () => {
  it("ignores case, spacing and modifier order", () => {
    expect(sameAccelerator("CmdOrCtrl+Shift+Space", " ctrl + shift+space ", false)).toBe(true);
    expect(sameAccelerator("Shift+Alt+F9", "Alt+Shift+F9", true)).toBe(true);
  });

  it("treats CmdOrCtrl as Ctrl except on macOS", () => {
    expect(sameAccelerator("CmdOrCtrl+V", "Ctrl+V", false)).toBe(true);
    expect(sameAccelerator("CmdOrCtrl+V", "Ctrl+V", true)).toBe(false);
  });

  it("tells different shortcuts apart and never matches an empty one", () => {
    expect(sameAccelerator("CmdOrCtrl+Shift+V", "CmdOrCtrl+Shift+Space", false)).toBe(false);
    expect(sameAccelerator("", "", false)).toBe(false);
    expect(sameAccelerator("Shift+Space", "", false)).toBe(false);
  });
});
