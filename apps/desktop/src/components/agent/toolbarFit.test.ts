import { describe, expect, it } from "vitest";
import { toolbarFold } from "./toolbarFit";

describe("composer toolbar folding", () => {
  it("moves one session option into the menu per step, keeping the first", () => {
    expect(toolbarFold(6, 0, false)).toMatchObject({ inline: 6, iconButtons: false, last: false });
    expect(toolbarFold(6, 2, false)).toMatchObject({ inline: 4, iconButtons: false });
    expect(toolbarFold(6, 5, false)).toMatchObject({ inline: 1, iconButtons: false, last: false });
  });

  it("drops the Stop / Send labels only once a single option is left, then the working dot", () => {
    expect(toolbarFold(6, 6, false)).toMatchObject({ inline: 1, iconButtons: true, bare: false, last: false });
    expect(toolbarFold(6, 7, false)).toMatchObject({ inline: 1, iconButtons: true, bare: true, last: true });
    expect(toolbarFold(1, 1, false)).toMatchObject({ inline: 1, iconButtons: true, last: false });
  });

  it("an agent without options can still drop the labels and the dot", () => {
    expect(toolbarFold(0, 0, false)).toMatchObject({ inline: 0, iconButtons: false, last: false });
    expect(toolbarFold(0, 1, false)).toMatchObject({ inline: 0, iconButtons: true, last: false });
    expect(toolbarFold(0, 2, false)).toMatchObject({ inline: 0, bare: true, last: true });
  });

  it("a tight composer starts with one option and icon buttons", () => {
    expect(toolbarFold(6, 0, true)).toMatchObject({ step: 6, inline: 1, iconButtons: true, bare: false });
    expect(toolbarFold(6, 7, true)).toMatchObject({ step: 7, bare: true, last: true });
  });
});
