import { describe, expect, it } from "vitest";
import {
  clampOffset,
  nudgeFor,
  offsetTransform,
  parseOffset,
  serializeOffset,
  type BaseRect,
} from "./panelPosition";

// A 340x300 panel at the default bottom-right spot of a 1200x800 window (16px right, 16px bottom).
const base: BaseRect = { left: 1200 - 16 - 340, top: 800 - 16 - 300, width: 340, height: 300 };
const vp = { width: 1200, height: 800 };

describe("clampOffset", () => {
  it("leaves an offset that fits alone", () => {
    expect(clampOffset({ x: -100, y: -50 }, base, vp)).toEqual({ x: -100, y: -50 });
  });
  it("keeps the panel inside every edge", () => {
    // Far left/up: left edge lands at the 8px margin.
    expect(clampOffset({ x: -5000, y: -5000 }, base, vp)).toEqual({ x: 8 - base.left, y: 8 - base.top });
    // Far right/down: right and bottom edges land 8px from the window edge.
    expect(clampOffset({ x: 5000, y: 5000 }, base, vp)).toEqual({ x: 16 - 8, y: 16 - 8 });
  });
  it("rounds to whole pixels", () => {
    expect(clampOffset({ x: -10.4, y: -20.6 }, base, vp)).toEqual({ x: -10, y: -21 });
  });
  it("re-fits after the window shrinks", () => {
    const small = { width: 500, height: 400 };
    const b: BaseRect = { left: 500 - 16 - 340, top: 400 - 16 - 300, width: 340, height: 300 };
    const c = clampOffset({ x: -700, y: -600 }, b, small);
    expect(b.left + c.x).toBeGreaterThanOrEqual(8);
    expect(b.top + c.y).toBeGreaterThanOrEqual(8);
  });
  it("keeps the top-left visible when the panel is bigger than the window", () => {
    const tiny = { width: 300, height: 200 };
    const b: BaseRect = { left: -40, top: -100, width: 340, height: 300 };
    expect(clampOffset({ x: 0, y: 0 }, b, tiny)).toEqual({ x: 48, y: 108 });
  });
});

describe("parseOffset / serializeOffset", () => {
  it("round-trips", () => {
    expect(parseOffset(serializeOffset({ x: -120, y: -48 }))).toEqual({ x: -120, y: -48 });
  });
  it("stores the default position as nothing", () => {
    expect(serializeOffset({ x: 0, y: 0 })).toBeNull();
  });
  it("falls back to the default for garbage", () => {
    for (const raw of [null, undefined, "", "nope", "[]", "null", "5", '{"x":1}', '{"x":"a","y":2}', '{"x":1e99,"y":0}']) {
      expect(parseOffset(raw as string | null | undefined)).toEqual({ x: 0, y: 0 });
    }
  });
  it("rounds stored fractions", () => {
    expect(parseOffset('{"x":-10.6,"y":3.2}')).toEqual({ x: -11, y: 3 });
  });
});

describe("nudgeFor / offsetTransform", () => {
  it("maps arrows to 16px, 64px with shift", () => {
    expect(nudgeFor("ArrowLeft", false)).toEqual({ x: -16, y: 0 });
    expect(nudgeFor("ArrowDown", true)).toEqual({ x: 0, y: 64 });
    expect(nudgeFor("a", false)).toBeNull();
  });
  it("builds a compositor-only transform", () => {
    expect(offsetTransform({ x: -4, y: 9 })).toBe("translate3d(-4px, 9px, 0)");
  });
});
