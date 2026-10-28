import { describe, expect, it } from "vitest";
import {
  CHAT_MIN_WIDTH,
  clampPreviewWidth,
  INSPECTOR_WIDTH,
  PREVIEW_MIN_WIDTH,
  previewLayout,
} from "./layout";

describe("clampPreviewWidth", () => {
  it("keeps both sides at their minimum", () => {
    expect(clampPreviewWidth(100, 1000)).toBe(PREVIEW_MIN_WIDTH);
    expect(clampPreviewWidth(5000, 1000)).toBe(1000 - CHAT_MIN_WIDTH);
    expect(clampPreviewWidth(500.4, 1000)).toBe(500);
  });
  it("never goes below the preview minimum when room is short", () => {
    expect(clampPreviewWidth(500, 500)).toBe(PREVIEW_MIN_WIDTH);
  });
});

describe("previewLayout", () => {
  it("splits with the inspector when everything fits", () => {
    const l = previewLayout(1400, true, 560);
    expect(l).toEqual({ mode: "split", inspector: true, width: 560 });
  });
  it("drops the inspector first for room", () => {
    const w = CHAT_MIN_WIDTH + PREVIEW_MIN_WIDTH + INSPECTOR_WIDTH - 1;
    expect(previewLayout(w, true, 560)).toMatchObject({ mode: "split", inspector: false });
  });
  it("drops the inspector when it would squeeze the conversation", () => {
    expect(previewLayout(1100, true, 560)).toMatchObject({ mode: "split", inspector: false, width: 560 });
    expect(previewLayout(1100, true, 320)).toMatchObject({ inspector: true, width: 320 });
  });
  it("clamps the width to what the chat can spare", () => {
    expect(previewLayout(900, false, 800).width).toBe(900 - CHAT_MIN_WIDTH);
  });
  it("takes the whole view when chat and preview can't sit side by side", () => {
    expect(previewLayout(600, false, 560)).toMatchObject({ mode: "full", inspector: false });
  });
  it("does not go full before the first measurement", () => {
    expect(previewLayout(0, true, 560).mode).toBe("split");
  });
});
