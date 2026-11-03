import { describe, expect, it } from "vitest";
import type { WakeStatus } from "./types";
import { DEFAULT_WAKE_PHRASE, wakeLine, wakePhraseProblem } from "./wakePhrase";

describe("wakePhraseProblem", () => {
  it("accepts the default phrase and ordinary two to five word phrases", () => {
    expect(wakePhraseProblem(DEFAULT_WAKE_PHRASE)).toBeNull();
    expect(wakePhraseProblem("ok computer")).toBeNull();
    expect(wakePhraseProblem("one two three four five")).toBeNull();
    expect(wakePhraseProblem("  Hey   Kvistcode  ")).toBeNull();
  });

  it("asks for a phrase when empty or blank", () => {
    const msg = "Enter a wake phrase, like “Hey Kvistcode”.";
    expect(wakePhraseProblem("")).toBe(msg);
    expect(wakePhraseProblem("   ")).toBe(msg);
  });

  it("allows 40 characters and refuses 41", () => {
    const ok = `${"a".repeat(19)} ${"b".repeat(20)}`;
    expect(ok).toHaveLength(40);
    expect(wakePhraseProblem(ok)).toBeNull();
    expect(wakePhraseProblem(`${ok}b`)).toBe("The wake phrase can be up to 40 characters.");
  });

  it("counts the length of the trimmed text, and characters rather than bytes", () => {
    const ok = `${"a".repeat(19)} ${"b".repeat(20)}`;
    expect(wakePhraseProblem(`  ${ok}  `)).toBeNull();
    expect(wakePhraseProblem(`${"é".repeat(20)} ${"ß".repeat(19)}`)).toBeNull();
  });

  it("allows letters of any script, apostrophes and hyphens", () => {
    expect(wakePhraseProblem("Hej Kvistkod")).toBeNull();
    expect(wakePhraseProblem("привет компьютер")).toBeNull();
    expect(wakePhraseProblem("你好 助手")).toBeNull();
    expect(wakePhraseProblem("Hey Kvist's")).toBeNull();
    expect(wakePhraseProblem("Hey Kvist’s")).toBeNull();
    expect(wakePhraseProblem("Hey Kvist-code")).toBeNull();
  });

  it("refuses digits, punctuation and symbols", () => {
    const msg = "Use only words in the wake phrase.";
    expect(wakePhraseProblem("Hey Kvistcode 2")).toBe(msg);
    expect(wakePhraseProblem("Hey, Kvistcode")).toBe(msg);
    expect(wakePhraseProblem("Hey Kvistcode!")).toBe(msg);
    expect(wakePhraseProblem("Hey @Kvistcode")).toBe(msg);
    expect(wakePhraseProblem("Hey 🙂")).toBe(msg);
  });

  it("wants at least two words", () => {
    const msg = "Use at least two words, like “Hey Kvistcode”, so everyday talk doesn't start it.";
    expect(wakePhraseProblem("Kvistcode")).toBe(msg);
    expect(wakePhraseProblem("  Kvistcode  ")).toBe(msg);
    // A hyphen joins one word.
    expect(wakePhraseProblem("Kvist-code")).toBe(msg);
  });

  it("allows five words and refuses six, counting after collapsing spaces", () => {
    expect(wakePhraseProblem("a   b   c   d   e")).toBeNull();
    expect(wakePhraseProblem("a b c d e f")).toBe("Use five words or fewer.");
  });

  it("reports the first failing rule", () => {
    // Too long and also has digits: the length comes first.
    expect(wakePhraseProblem(`${"a".repeat(41)} 1`)).toBe("The wake phrase can be up to 40 characters.");
    // Has digits and is one word: the characters come first.
    expect(wakePhraseProblem("abc1")).toBe("Use only words in the wake phrase.");
    // Six short words in range: only the word count fails.
    expect(wakePhraseProblem("a b c d e f")).toBe("Use five words or fewer.");
  });
});

describe("wakeLine", () => {
  const status = (patch: Partial<WakeStatus>): WakeStatus => ({
    state: "listening",
    phrase: "Hey Kvistcode",
    model: "tiny.en",
    message: null,
    ...patch,
  });

  it("shows nothing while the wake phrase is off", () => {
    expect(wakeLine(status({}), false, true)).toBeNull();
  });

  it("asks to turn the assistant on first, whatever the status says", () => {
    expect(wakeLine(status({}), true, false)).toEqual({
      kind: "info",
      text: "Turn on the voice assistant to use a wake phrase.",
    });
  });

  it("shows nothing until the first status arrives", () => {
    expect(wakeLine(null, true, true)).toBeNull();
  });

  it("says what it listens for", () => {
    expect(wakeLine(status({ phrase: "OK Kvist" }), true, true)).toEqual({
      kind: "listening",
      text: "Listening for “OK Kvist”",
    });
  });

  it("offers the model download, and shows start-up", () => {
    expect(wakeLine(status({ state: "needsModel" }), true, true)?.kind).toBe("download");
    expect(wakeLine(status({ state: "starting" }), true, true)).toEqual({ kind: "starting", text: "Starting…" });
  });

  it("passes the reason for waiting and for errors on", () => {
    expect(wakeLine(status({ state: "waiting", message: "Paused while you dictate." }), true, true)).toEqual({
      kind: "info",
      text: "Paused while you dictate.",
    });
    expect(wakeLine(status({ state: "error", message: "No microphone found." }), true, true)).toEqual({
      kind: "error",
      text: "No microphone found.",
    });
  });

  it("shows an off reason only when there is one", () => {
    expect(wakeLine(status({ state: "off" }), true, true)).toBeNull();
    expect(wakeLine(status({ state: "off", message: "Turn on the voice assistant first." }), true, true)).toEqual({
      kind: "info",
      text: "Turn on the voice assistant first.",
    });
  });
});
