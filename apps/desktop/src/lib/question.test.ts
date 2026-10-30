import { describe, expect, it } from "vitest";
import {
  EMPTY_DRAFT,
  buildAnswers,
  canSubmit,
  firstOpenGroup,
  invalidNumbers,
  nextOpenGroup,
  parseNumber,
  missingRequired,
  questionGroups,
  setBool,
  setText,
  summarizeAnswers,
  toggleOther,
  togglePick,
  type QuestionItem,
} from "./question";
import type { QuestionField } from "./types";

const opts = [
  { value: "pg", label: "Postgres" },
  { value: "sqlite", label: "SQLite" },
];
const fields: QuestionField[] = [
  { id: "question_0", title: "Database", kind: "single", options: opts, required: true },
  { id: "question_0_custom", kind: "text", otherFor: "question_0" },
  { id: "question_1", title: "Features", kind: "multi", options: opts },
  { id: "question_1_custom", kind: "text", otherFor: "question_1" },
];
const [g0, g1] = questionGroups(fields);

describe("questionGroups", () => {
  it("folds Other boxes into their choice field", () => {
    expect(questionGroups(fields).map((g) => [g.field.id, g.other?.id])).toEqual([
      ["question_0", "question_0_custom"],
      ["question_1", "question_1_custom"],
    ]);
  });
  it("keeps an orphan otherFor field as its own question", () => {
    const g = questionGroups([{ id: "x", kind: "text", otherFor: "missing" }]);
    expect(g).toHaveLength(1);
  });
});

describe("buildAnswers", () => {
  it("is empty for an untouched draft", () => {
    expect(buildAnswers(fields, EMPTY_DRAFT)).toEqual({});
  });
  it("single pick and multi picks", () => {
    let d = togglePick(EMPTY_DRAFT, g0, "pg");
    d = togglePick(d, g1, "pg");
    d = togglePick(d, g1, "sqlite");
    d = togglePick(d, g1, "pg");
    expect(buildAnswers(fields, d)).toEqual({ question_0: "pg", question_1: ["sqlite"] });
  });
  it("Other text replaces the pick of a single field", () => {
    let d = togglePick(EMPTY_DRAFT, g0, "pg");
    d = setText(toggleOther(d, g0), "question_0_custom", "  MySQL ");
    expect(buildAnswers(fields, d)).toEqual({ question_0_custom: "MySQL" });
    // Picking an option again leaves Other.
    expect(buildAnswers(fields, togglePick(d, g0, "sqlite"))).toEqual({ question_0: "sqlite" });
  });
  it("Other text adds to the picks of a multi field", () => {
    let d = togglePick(EMPTY_DRAFT, g1, "pg");
    d = setText(toggleOther(d, g1), "question_1_custom", "Redis");
    expect(buildAnswers(fields, d)).toEqual({ question_1: ["pg"], question_1_custom: "Redis" });
  });
  it("ignores empty Other text and typed text while Other is off", () => {
    const d = setText(EMPTY_DRAFT, "question_0_custom", "hello");
    expect(buildAnswers(fields, d)).toEqual({});
    expect(buildAnswers(fields, toggleOther(d, g0))).toEqual({ question_0_custom: "hello" });
  });
  it("handles text, number and boolean fields", () => {
    const f: QuestionField[] = [
      { id: "t", kind: "text" },
      { id: "n", kind: "number" },
      { id: "b", kind: "boolean" },
      { id: "n2", kind: "number" },
    ];
    let d = setText(EMPTY_DRAFT, "t", " hi ");
    d = setText(d, "n", "4.5");
    d = setText(d, "n2", "abc");
    d = setBool(d, "b", false);
    expect(buildAnswers(f, d)).toEqual({ t: "hi", n: 4.5, b: false });
  });
});

describe("validation", () => {
  it("reports required fields without an answer", () => {
    expect(missingRequired(fields, EMPTY_DRAFT)).toEqual(["question_0"]);
    expect(canSubmit(fields, EMPTY_DRAFT)).toBe(false);
  });
  it("an Other answer satisfies a required choice field", () => {
    const d = setText(toggleOther(EMPTY_DRAFT, g0), "question_0_custom", "MySQL");
    expect(missingRequired(fields, d)).toEqual([]);
    expect(canSubmit(fields, d)).toBe(true);
  });
  it("needs at least one answer even when nothing is required", () => {
    expect(canSubmit([{ id: "t", kind: "text" }], EMPTY_DRAFT)).toBe(false);
    expect(canSubmit([{ id: "t", kind: "text" }], setText(EMPTY_DRAFT, "t", "x"))).toBe(true);
  });
});

describe("parseNumber", () => {
  it("reads plain numbers", () => {
    expect(parseNumber(" 4.5 ")).toBe(4.5);
    expect(parseNumber("-3")).toBe(-3);
    expect(parseNumber("1e3")).toBe(1000);
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("abc")).toBeNull();
    expect(parseNumber("0x10")).toBeNull();
    expect(parseNumber("Infinity")).toBeNull();
  });
  it("treats a lone comma as a decimal point", () => {
    expect(parseNumber("1,5")).toBe(1.5);
    expect(parseNumber("0,25")).toBe(0.25);
    expect(parseNumber("12,34")).toBe(12.34);
  });
  it("treats well-formed digit groups as thousands", () => {
    expect(parseNumber("1,000")).toBe(1000);
    expect(parseNumber("1,000,000")).toBe(1000000);
    expect(parseNumber("1,234.5")).toBe(1234.5);
  });
  it("rejects ambiguous or malformed comma use", () => {
    expect(parseNumber("1,2,3")).toBeNull();
    expect(parseNumber("1,23.4")).toBeNull();
    expect(parseNumber("1.000,5")).toBeNull();
    expect(parseNumber(",5,")).toBeNull();
  });
});

describe("invalid numbers", () => {
  const f: QuestionField[] = [
    { id: "n", kind: "number" },
    { id: "t", kind: "text" },
  ];
  it("flags non-empty text that isn't a number and blocks submit", () => {
    const d = setText(setText(EMPTY_DRAFT, "t", "x"), "n", "abc");
    expect(invalidNumbers(f, d)).toEqual(["n"]);
    expect(canSubmit(f, d)).toBe(false);
    expect(canSubmit(f, setText(d, "n", "12"))).toBe(true);
  });
  it("empty number text is fine", () => {
    expect(invalidNumbers(f, setText(EMPTY_DRAFT, "n", "  "))).toEqual([]);
  });
});

describe("nextOpenGroup", () => {
  it("finds the next unanswered question from an index", () => {
    const gs = questionGroups(fields);
    expect(nextOpenGroup(gs, EMPTY_DRAFT)).toBe(0);
    const d = togglePick(EMPTY_DRAFT, gs[0], "pg");
    expect(nextOpenGroup(gs, d)).toBe(1);
    expect(nextOpenGroup(gs, d, 2)).toBe(-1);
    expect(firstOpenGroup(gs, togglePick(d, gs[1], "pg"))).toBe(0);
  });
});

describe("summarizeAnswers", () => {
  const item = {
    id: "q",
    ts: 0,
    kind: "question",
    requestId: "r",
    message: "m",
    fields: [...fields, { id: "pw", title: "Key", kind: "text", secret: true }, { id: "ok", kind: "boolean" }],
    resolution: "answered",
    answers: { question_0_custom: "MySQL", question_1: ["pg", "sqlite"], pw: "secret", ok: true },
  } as unknown as QuestionItem;
  it("maps values to labels and marks custom text", () => {
    expect(summarizeAnswers(item)).toEqual([
      { id: "question_0", title: "Database", chips: [{ text: "MySQL", custom: true }] },
      {
        id: "question_1",
        title: "Features",
        chips: [
          { text: "Postgres", custom: false },
          { text: "SQLite", custom: false },
        ],
      },
      { id: "pw", title: "Key", chips: [{ text: "••••••••", custom: false }] },
      { id: "ok", title: "ok", chips: [{ text: "Yes", custom: false }] },
    ]);
  });
});
