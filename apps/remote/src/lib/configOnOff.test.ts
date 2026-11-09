import { describe, expect, it } from "vitest";
import { onOff } from "./config";
import type { ConfigOption } from "./types";

const opt = (names: string[]): ConfigOption =>
  ({ id: "fast", name: "Fast mode", category: null, currentValue: "off", options: names.map((n) => ({ value: n.toLowerCase(), name: n, description: null })) }) as ConfigOption;

describe("onOff", () => {
  it("finds the values of an On/Off option", () => {
    expect(onOff(opt(["On", "Off"]))).toEqual({ on: "on", off: "off" });
  });
  it("leaves other options as lists", () => {
    expect(onOff(opt(["Low", "High"]))).toBeNull();
    expect(onOff(opt(["On", "Off", "Auto"]))).toBeNull();
  });
});
