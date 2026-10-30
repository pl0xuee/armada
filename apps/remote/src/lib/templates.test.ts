import { describe, expect, it } from "vitest";
import { allFieldsFilled, fillTemplate, filterTemplates, insertAtCaret, placeholderLabel, templateParts, templatePlaceholders } from "./templates";

describe("template placeholders", () => {
  const body = "Review {{ focus }} in {{file}}, then {{focus}} again.";
  it("lists unique names in order of first appearance", () => {
    expect(templatePlaceholders(body)).toEqual(["focus", "file"]);
    expect(templatePlaceholders("no fields")).toEqual([]);
  });
  it("fills every use of a field and keeps blank ones as written", () => {
    expect(fillTemplate(body, { focus: " security ", file: "a.ts" })).toBe("Review security in a.ts, then security again.");
    expect(fillTemplate(body, { focus: "perf", file: "  " })).toBe("Review perf in {{file}}, then perf again.");
  });
  it("labels fields for people", () => {
    expect(placeholderLabel("target_file")).toBe("Target file");
    expect(placeholderLabel("api-key")).toBe("Api key");
  });
});

describe("filterTemplates", () => {
  const list = [
    { id: "1", name: "Review PR", text: "Look at the diff." },
    { id: "2", name: "Fix CI", text: "CI is red on main." },
  ];
  it("matches the name or the text", () => {
    expect(filterTemplates(list, "review").map((t) => t.id)).toEqual(["1"]);
    expect(filterTemplates(list, " MAIN ").map((t) => t.id)).toEqual(["2"]);
    expect(filterTemplates(list, "zzz")).toEqual([]);
  });
  it("returns everything for an empty query", () => {
    expect(filterTemplates(list, "  ")).toBe(list);
  });
});

describe("insertAtCaret", () => {
  it("replaces an empty box", () => {
    expect(insertAtCaret("  ", "Hello", 1, 1)).toEqual({ text: "Hello", caret: 5 });
  });
  it("inserts at the caret", () => {
    expect(insertAtCaret("ab cd", "XY", 2, 2)).toEqual({ text: "abXY cd", caret: 4 });
  });
  it("replaces the selection", () => {
    expect(insertAtCaret("ab cd", "XY", 0, 2)).toEqual({ text: "XY cd", caret: 2 });
  });
  it("appends when the caret is unknown or out of range", () => {
    expect(insertAtCaret("abc", "Z", null, null)).toEqual({ text: "abcZ", caret: 4 });
    expect(insertAtCaret("abc", "Z", 99, 120)).toEqual({ text: "abcZ", caret: 4 });
  });
});

describe("allFieldsFilled", () => {
  it("needs something in every field", () => {
    expect(allFieldsFilled(["a", "b"], { a: "x", b: "y" })).toBe(true);
    expect(allFieldsFilled(["a", "b"], { a: "x" })).toBe(false);
    expect(allFieldsFilled(["a", "b"], { a: "x", b: "   " })).toBe(false);
    expect(allFieldsFilled([], {})).toBe(true);
  });
});

describe("templateParts", () => {
  it("splits text from placeholders", () => {
    expect(templateParts("Fix {{ target_file }} in {{area}}.")).toEqual([
      { text: "Fix " },
      { field: "target_file" },
      { text: " in " },
      { field: "area" },
      { text: "." },
    ]);
    expect(templateParts("plain")).toEqual([{ text: "plain" }]);
    expect(templateParts("{{a}}")).toEqual([{ field: "a" }]);
    expect(templateParts("")).toEqual([]);
  });
});
