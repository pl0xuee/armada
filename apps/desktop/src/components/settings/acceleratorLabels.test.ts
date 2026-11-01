import { describe, expect, it } from "vitest";
import { acceleratorCaps } from "./acceleratorLabels";

describe("acceleratorCaps", () => {
  it("uses symbols on macOS, with Command last", () => {
    expect(acceleratorCaps("CmdOrCtrl+Ctrl+Shift+Space", true)).toEqual(["⌃", "⇧", "⌘", "Space"]);
  });

  it("merges CmdOrCtrl with Ctrl elsewhere", () => {
    expect(acceleratorCaps("CmdOrCtrl+Ctrl+Shift+Space", false)).toEqual(["Ctrl", "Shift", "Space"]);
    expect(acceleratorCaps("CmdOrCtrl+Alt+K", false)).toEqual(["Ctrl", "Alt", "K"]);
  });

  it("reads Super as the Windows or Linux key", () => {
    expect(acceleratorCaps("Super+Shift+a", false)).toEqual(["Shift", "Super", "A"]);
  });

  it("shows arrows and function keys", () => {
    expect(acceleratorCaps("Alt+Up", true)).toEqual(["⌥", "↑"]);
    expect(acceleratorCaps("F5", false)).toEqual(["F5"]);
  });

  it("is empty for an empty accelerator", () => {
    expect(acceleratorCaps("", true)).toEqual([]);
  });
});
