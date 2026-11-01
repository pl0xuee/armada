import { describe, expect, it } from "vitest";
import {
  CODE_COLLAPSE_LINES,
  LINE_LIMIT,
  LINE_PX,
  codeCollapses,
  collapseLimitPx,
  hiddenLines,
  messageRole,
  shouldCollapse,
} from "./collapse";

const idle = { streaming: false, watched: false };
const lines = (n: number, role: "latest" | "answer" | "narration") => n * LINE_PX[role];

describe("shouldCollapse", () => {
  it("folds narration after about six lines, answers after about eighteen", () => {
    expect(shouldCollapse(lines(5, "narration"), "narration", idle)).toBe(false);
    expect(shouldCollapse(lines(12, "narration"), "narration", idle)).toBe(true);
    expect(shouldCollapse(lines(17, "answer"), "answer", idle)).toBe(false);
    expect(shouldCollapse(lines(30, "answer"), "answer", idle)).toBe(true);
  });

  it("doesn't fold for a line or two (not worth a control)", () => {
    expect(shouldCollapse(lines(LINE_LIMIT.narration + 1, "narration"), "narration", idle)).toBe(false);
    expect(shouldCollapse(lines(LINE_LIMIT.answer + 1, "answer"), "answer", idle)).toBe(false);
  });

  it("only folds the latest answer when it is enormous", () => {
    expect(shouldCollapse(lines(45, "latest"), "latest", idle)).toBe(false);
    expect(shouldCollapse(lines(61, "latest"), "latest", idle)).toBe(false);
    expect(shouldCollapse(lines(90, "latest"), "latest", idle)).toBe(true);
  });

  it("never folds what is streaming or what the reader watched grow", () => {
    expect(shouldCollapse(5000, "narration", { streaming: true, watched: false })).toBe(false);
    expect(shouldCollapse(5000, "answer", { streaming: false, watched: true })).toBe(false);
  });
});

describe("hiddenLines / limits", () => {
  it("counts what a fold hides", () => {
    expect(hiddenLines(collapseLimitPx("answer") + 10 * LINE_PX.answer, "answer")).toBe(10);
    expect(hiddenLines(0, "answer")).toBe(1);
  });
});

describe("codeCollapses", () => {
  it("folds long code unless it was watched streaming", () => {
    expect(codeCollapses(CODE_COLLAPSE_LINES, false)).toBe(false);
    expect(codeCollapses(CODE_COLLAPSE_LINES + 1, false)).toBe(true);
    expect(codeCollapses(200, true)).toBe(false);
  });
});

describe("messageRole", () => {
  const m = { final: true, latest: true, trailingActivity: false, turnOpen: false };
  it("types the closing message of the latest turn as the answer", () => {
    expect(messageRole(m)).toBe("latest");
    expect(messageRole({ ...m, latest: false })).toBe("answer");
  });
  it("types everything before it as narration", () => {
    expect(messageRole({ ...m, final: false })).toBe("narration");
  });
  it("keeps the newest message the answer while it streams, and demotes it once the agent moves on", () => {
    expect(messageRole({ ...m, turnOpen: true })).toBe("latest");
    expect(messageRole({ ...m, turnOpen: true, trailingActivity: true })).toBe("narration");
  });
  it("promotes it again when the turn ends on a tool call (there is no better answer)", () => {
    expect(messageRole({ ...m, turnOpen: false, trailingActivity: true })).toBe("latest");
  });
});
