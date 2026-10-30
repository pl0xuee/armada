import { describe, expect, it } from "vitest";
import { buildAnswers, canSubmit, estimateQuestion, otherOf, parseNumber, primaryFields, problems, summarize } from "./question";
import type { QuestionField, QuestionItem } from "./types";

const opts = [
  { value: "pg", label: "PostgreSQL" },
  { value: "redis", label: "Redis" },
  { value: "sqlite", label: "SQLite" },
];
const fields: QuestionField[] = [
  { id: "q0", title: "DB", kind: "single", required: true, options: opts },
  { id: "q0_custom", kind: "text", otherFor: "q0" },
  { id: "q1", title: "Channels", kind: "multi", options: opts },
  { id: "q1_custom", kind: "text", otherFor: "q1" },
];

describe("primaryFields / otherOf", () => {
  it("hides Other boxes that belong to a choice field", () => {
    expect(primaryFields(fields).map((f) => f.id)).toEqual(["q0", "q1"]);
    expect(otherOf(fields, "q0")?.id).toBe("q0_custom");
    expect(otherOf(fields, "nope")).toBeNull();
  });
  it("keeps an orphan otherFor field as its own question", () => {
    const f: QuestionField[] = [{ id: "t", kind: "text", otherFor: "missing" }];
    expect(primaryFields(f)).toHaveLength(1);
  });
});

describe("parseNumber", () => {
  it("parses decimals and rejects junk", () => {
    expect(parseNumber(" 3,5 ")).toBe(3.5);
    expect(parseNumber("-2")).toBe(-2);
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("abc")).toBeNull();
    expect(parseNumber("Infinity")).toBeNull();
  });
});

describe("buildAnswers", () => {
  it("omits unanswered fields and trims text", () => {
    expect(buildAnswers(fields, { q0_custom: "  Mongo " })).toEqual({ q0_custom: "Mongo" });
    expect(buildAnswers(fields, { q0: "pg", q1: [] })).toEqual({ q0: "pg" });
  });
  it("orders multi answers by option order", () => {
    expect(buildAnswers(fields, { q1: ["sqlite", "pg"] })).toEqual({ q1: ["pg", "sqlite"] });
  });
  it("types booleans and numbers", () => {
    const f: QuestionField[] = [
      { id: "b", kind: "boolean" },
      { id: "n", kind: "number" },
      { id: "x", kind: "number" },
    ];
    expect(buildAnswers(f, { b: false, n: "4,5", x: "zz" })).toEqual({ b: false, n: 4.5 });
  });
});

describe("validation", () => {
  it("requires required fields, satisfied by an option or Other text", () => {
    expect(problems(fields, {})).toEqual(["q0"]);
    expect(canSubmit(fields, { q0: "pg" })).toBe(true);
    expect(canSubmit(fields, { q0_custom: "Mongo" })).toBe(true);
    expect(canSubmit(fields, { q0_custom: "   " })).toBe(false);
  });
  it("flags numbers that do not parse, required or not", () => {
    const f: QuestionField[] = [{ id: "n", kind: "number" }];
    expect(problems(f, { n: "x" })).toEqual(["n"]);
    expect(problems(f, {})).toEqual([]);
  });
  it("requires a boolean to be chosen when required", () => {
    const f: QuestionField[] = [{ id: "b", kind: "boolean", required: true }];
    expect(canSubmit(f, {})).toBe(false);
    expect(canSubmit(f, { b: false })).toBe(true);
  });
});

const item = (over: Partial<QuestionItem>): QuestionItem => ({
  id: "i",
  agentId: "a",
  seq: 1,
  ts: 0,
  kind: "question",
  requestId: "r",
  message: "m",
  fields,
  resolution: "answered",
  ...over,
});

describe("summarize", () => {
  it("shows option labels, Other text and secrets", () => {
    const rows = summarize(item({ answers: { q0: "pg", q1: ["redis", "sqlite"], q1_custom: "NATS" } }));
    expect(rows).toEqual([
      { label: "DB", value: "PostgreSQL" },
      { label: "Channels", value: "Redis, SQLite, NATS" },
    ]);
    const secret = summarize(item({ fields: [{ id: "k", title: "Key", kind: "text", secret: true }], answers: { k: "hunter2" } }));
    expect(secret[0].value).not.toContain("hunter2");
  });
  it("has no label for a single question and nothing when skipped", () => {
    expect(summarize(item({ fields: fields.slice(0, 2), answers: { q0_custom: "Mongo" } }))).toEqual([{ label: null, value: "Mongo" }]);
    expect(summarize(item({ resolution: "skipped", answers: null }))).toEqual([]);
  });
  it("renders booleans as Yes/No", () => {
    expect(summarize(item({ fields: [{ id: "b", kind: "boolean" }], answers: { b: true } }))[0].value).toBe("Yes");
  });
});

describe("estimateQuestion", () => {
  it("grows with the options", () => {
    expect(estimateQuestion(item({}))).toBeGreaterThan(estimateQuestion(item({ fields: [{ id: "b", kind: "boolean" }] })));
  });
});
