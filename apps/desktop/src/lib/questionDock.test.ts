import { describe, expect, it } from "vitest";
import {
  EMPTY_DRAFT,
  boolAnswers,
  buildAnswers,
  canSubmit,
  pickAnswers,
  questionHeadline,
  questionShape,
  setText,
  toggleOther,
  togglePick,
  questionGroups,
} from "./question";
import type { QuestionField } from "./types";

const opt = (value: string) => ({ value, label: value.toUpperCase() });
const single = (n: number, extra: Partial<QuestionField> = {}): QuestionField[] => [
  {
    id: "q0",
    title: "Pick",
    description: "Which one?",
    kind: "single",
    options: Array.from({ length: n }, (_, i) => opt(`o${i}`)),
    ...extra,
  },
  { id: "q0_custom", kind: "text", otherFor: "q0" },
];

describe("questionShape: how the dock lets you answer", () => {
  it("answers a single question with up to four options in one click", () => {
    expect(questionShape(single(3)).mode).toBe("single");
    expect(questionShape(single(4)).mode).toBe("single");
  });
  it("gives a longer single choice the step-by-step form", () => {
    expect(questionShape(single(5)).mode).toBe("stepper");
  });
  it("uses checkboxes for one multi-select", () => {
    const fields: QuestionField[] = [{ id: "m", kind: "multi", options: [opt("a"), opt("b"), opt("c")] }];
    expect(questionShape(fields).mode).toBe("multi");
  });
  it("uses yes/no buttons for one boolean", () => {
    expect(questionShape([{ id: "b", kind: "boolean" }]).mode).toBe("bool");
  });
  it("steps through several questions, or a typed value", () => {
    const two = [...single(2), { id: "q1", kind: "single" as const, options: [opt("x")] }];
    const s = questionShape(two);
    expect(s.mode).toBe("stepper");
    expect(s.mode === "stepper" && s.groups).toHaveLength(2);
    expect(questionShape([{ id: "t", kind: "text" }]).mode).toBe("stepper");
    expect(questionShape([{ id: "n", kind: "number" }]).mode).toBe("stepper");
  });
});

describe("answers built in the dock match the card's", () => {
  it("one click on option i answers that option's value", () => {
    const fields = single(3);
    expect(pickAnswers(fields, 0, 1)).toEqual({ q0: "o1" });
    // Same as picking it in the card and building the draft's answers.
    const g = questionGroups(fields)[0];
    expect(pickAnswers(fields, 0, 1)).toEqual(buildAnswers(fields, togglePick(EMPTY_DRAFT, g, "o1")));
  });
  it("returns null for an option that does not exist", () => {
    expect(pickAnswers(single(2), 0, 5)).toBeNull();
    expect(pickAnswers(single(2), 3, 0)).toBeNull();
  });
  it("answers yes/no", () => {
    const fields: QuestionField[] = [{ id: "b", kind: "boolean" }];
    expect(boolAnswers(fields, 0, true)).toEqual({ b: true });
    expect(boolAnswers(fields, 0, false)).toEqual({ b: false });
    expect(boolAnswers(single(2), 0, true)).toBeNull();
  });
  it("multi-select sends the checked values, and 'Other' text on top", () => {
    const fields: QuestionField[] = [
      { id: "m", kind: "multi", options: [opt("a"), opt("b"), opt("c")] },
      { id: "m_custom", kind: "text", otherFor: "m" },
    ];
    const g = questionGroups(fields)[0];
    let d = togglePick(togglePick(EMPTY_DRAFT, g, "a"), g, "c");
    expect(buildAnswers(fields, d)).toEqual({ m: ["a", "c"] });
    d = togglePick(d, g, "a");
    expect(buildAnswers(fields, d)).toEqual({ m: ["c"] });
    d = setText(toggleOther(d, g), "m_custom", "  something else ");
    expect(buildAnswers(fields, d)).toEqual({ m: ["c"], m_custom: "something else" });
    expect(canSubmit(fields, EMPTY_DRAFT)).toBe(false);
    expect(canSubmit(fields, d)).toBe(true);
  });
  it("'Other' on a single question answers with the typed text only, and needs some text", () => {
    const fields = single(3);
    const g = questionGroups(fields)[0];
    let d = toggleOther(EMPTY_DRAFT, g);
    expect(canSubmit(fields, d)).toBe(false);
    d = setText(d, "q0_custom", "Bun");
    expect(buildAnswers(fields, d)).toEqual({ q0_custom: "Bun" });
    expect(canSubmit(fields, d)).toBe(true);
  });
  it("a required question can't be sent empty", () => {
    expect(canSubmit(single(3, { required: true }), EMPTY_DRAFT)).toBe(false);
  });
});

describe("questionHeadline", () => {
  it("prefers the message, then the first field's text", () => {
    const fields = single(2);
    expect(questionHeadline({ message: "Hello?", fields })).toBe("Hello?");
    expect(questionHeadline({ message: "", fields })).toBe("Which one?");
    expect(questionHeadline({ message: "", fields: [] })).toBe("Question");
  });
});
