import { beforeEach, describe, expect, it } from "vitest";
import { choiceHint, choicesFor, defaultWorkChoice, KEEP, optionNote, readWorkChoice, resolveWorkChoice, saveWorkChoice, switchNeedsNote } from "./modelGuide";
import { initialForm, validate, agentChoices, type NewAgentForm } from "./newAgent";
import type { Agent, RemoteAccount } from "./types";

beforeEach(() => localStorage.clear());

const claude = { provider: "claude" } as Agent;
const acc: RemoteAccount = { id: "c1", name: "c1", provider: "claude", color: "#4FC3F7", label: null };
const choices = agentChoices([acc, { ...acc, id: "x1", provider: "codex" }], []);
const form = (over: Partial<NewAgentForm> = {}): NewAgentForm => ({
  choiceKey: "claude", accountId: "c1", projectPath: "/home/me/app", worktree: false, title: "", prompt: "", attachments: [], model: "", permissionMode: null, workType: "everyday", ...over,
});

describe("kind of work", () => {
  it("picks the model and effort for Claude only", () => {
    expect(choicesFor("claude", "everyday")).toEqual({ model: "opus", effort: "medium" });
    expect(choicesFor("claude", "big")).toEqual({ model: "fable", effort: "medium" });
    expect(choicesFor("claude", KEEP)).toEqual({});
    expect(choicesFor("codex", "everyday")).toEqual({});
  });

  it("starts on Opus for a fresh computer and leaves a customised one alone", () => {
    expect(defaultWorkChoice(false)).toBe("everyday");
    expect(defaultWorkChoice(true)).toBe(KEEP);
    // An older server can't say: change nothing.
    expect(defaultWorkChoice(null)).toBe(KEEP);
  });

  it("remembers the last pick over the default", () => {
    expect(readWorkChoice()).toBeNull();
    saveWorkChoice("routine");
    expect(resolveWorkChoice(readWorkChoice(), false)).toBe("routine");
    localStorage.setItem("kvistcode.workType", "gone");
    expect(readWorkChoice()).toBeNull();
  });

  it("goes into the request for Claude, not for other agents", () => {
    const v = validate(form(), choices);
    expect(v.ok && v.request.configChoices).toEqual({ model: "opus", effort: "medium" });
    const other = validate(form({ choiceKey: "codex", accountId: "x1" }), choices);
    expect(other.ok && other.request.configChoices).toBeUndefined();
    const keep = validate(form({ workType: KEEP }), choices);
    expect(keep.ok && keep.request.configChoices).toBeUndefined();
  });

  it("lets a typed model win, keeping the effort", () => {
    const v = validate(form({ model: "sonnet" }), choices);
    expect(v.ok && v.request).toMatchObject({ model: "sonnet", configChoices: { effort: "medium" } });
  });

  it("seeds the form from what the computer says", () => {
    expect(initialForm(choices, [], false, {}, null, false).workType).toBe("everyday");
    expect(initialForm(choices, [], false, {}, null, true).workType).toBe(KEEP);
    expect(initialForm(choices, [], false, {}, null, null).workType).toBe(KEEP);
  });
});

describe("hints and the switch note", () => {
  const model = { id: "model", currentValue: "opus" };
  it("hints Claude's effort and model choices only", () => {
    expect(choiceHint(claude, { id: "effort" }, "medium")).toMatch(/start/i);
    expect(choiceHint(claude, { id: "model" }, "fable")).toMatch(/refactor/i);
    expect(choiceHint(claude, { id: "effort" }, "weird")).toBeNull();
    expect(choiceHint({ provider: "codex" } as Agent, { id: "effort" }, "medium")).toBeNull();
    expect(optionNote(claude, { id: "model" })).toMatch(/break/i);
    expect(optionNote(claude, { id: "mode" })).toBeNull();
  });

  it("asks only for a Claude model change at 100k tokens or more", () => {
    const long = { provider: "claude", contextUsed: 120_000 } as Agent;
    expect(switchNeedsNote(long, model, "sonnet")).toBe(true);
    expect(switchNeedsNote(long, model, "opus")).toBe(false);
    expect(switchNeedsNote({ provider: "claude", contextUsed: 50_000 } as Agent, model, "sonnet")).toBe(false);
    expect(switchNeedsNote(long, { id: "effort", currentValue: "low" }, "high")).toBe(false);
    expect(switchNeedsNote({ provider: "codex", contextUsed: 120_000 } as Agent, model, "sonnet")).toBe(false);
  });
});
