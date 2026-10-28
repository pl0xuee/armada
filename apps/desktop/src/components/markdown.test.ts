import { describe, expect, it } from "vitest";
import { splitBlockRanges, splitBlocks } from "./Markdown";

describe("splitBlocks", () => {
  it("splits paragraphs at blank lines", () => {
    expect(splitBlocks("One.\n\nTwo.\n\nThree.")).toEqual(["One.", "Two.", "Three."]);
  });

  it("keeps fenced code (with blank lines) together", () => {
    const md = "Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter";
    expect(splitBlocks(md)).toEqual(["Intro", "```ts\nconst a = 1;\n\nconst b = 2;\n```", "After"]);
  });

  it("only closes a fence with the same character", () => {
    const md = "~~~\na\n\n```\nb\n~~~\n\nnext";
    expect(splitBlocks(md)).toEqual(["~~~\na\n\n```\nb\n~~~", "next"]);
  });

  it("keeps loose lists and list continuations together", () => {
    const md = "- one\n\n- two\n\n  more about two\n\nParagraph";
    expect(splitBlocks(md)).toEqual(["- one\n\n- two\n\n  more about two", "Paragraph"]);
  });

  it("keeps indented code with its block", () => {
    const md = "Example:\n\n    code line\n\n    more code\n\nDone";
    expect(splitBlocks(md)).toEqual(["Example:\n\n    code line\n\n    more code", "Done"]);
  });

  it("an unterminated fence (still streaming) stays one block", () => {
    expect(splitBlocks("Text\n\n```js\nlet x\n\nlet y")).toEqual(["Text", "```js\nlet x\n\nlet y"]);
  });

  it("re-scanning from the last block start matches a full scan", () => {
    const full = "A\n\nB\n\n- x\n\n- y\n\nC";
    const ranges = splitBlockRanges(full);
    const lastStart = ranges[ranges.length - 2].start;
    const incremental = [...ranges.slice(0, -2), ...splitBlockRanges(full, lastStart)];
    expect(incremental).toEqual(ranges);
  });
});
