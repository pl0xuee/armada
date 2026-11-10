import { beforeEach, describe, expect, it } from "vitest";
import {
  availableWorkTypes,
  choiceHint,
  choicesFor,
  defaultWorkChoice,
  KEEP,
  menuNote,
  readWorkChoice,
  resolveWorkChoice,
  saveWorkChoice,
  switchNeedsNote,
  WORK_TYPES,
} from "./modelGuide";
import type { Agent, ConfigOption } from "./types";

const option = (id: string, values: string[], currentValue = values[0]): ConfigOption => ({
  id,
  name: id,
  category: id === "model" ? "model" : "thought_level",
  currentValue,
  options: values.map((value) => ({ value, name: value, description: null })),
});
const agent = (over: Partial<Agent> = {}): Agent =>
  ({ provider: "claude", configOptions: [], contextUsed: 0, ...over }) as unknown as Agent;

// Tiny in-memory localStorage for node.
beforeEach(() => {
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
});

describe("work types", () => {
  it("starts on Opus at medium for everyday coding", () => {
    expect(choicesFor("claude", "everyday")).toEqual({ model: "opus", effort: "medium" });
    expect(choicesFor("claude", "routine")).toEqual({ model: "sonnet", effort: "medium" });
    expect(choicesFor("claude", "quick")).toEqual({ model: "haiku", effort: "medium" });
    expect(choicesFor("claude", "big")).toEqual({ model: "fable", effort: "medium" });
  });

  it("asks for nothing when keeping the usual model, for an unknown pick, or on other providers", () => {
    expect(choicesFor("claude", KEEP)).toEqual({});
    expect(choicesFor("claude", "nope")).toEqual({});
    expect(choicesFor("codex", "everyday")).toEqual({});
    expect(choicesFor("grok", "big")).toEqual({});
  });

  it("remembers the last pick and ignores a stale one", () => {
    expect(readWorkChoice()).toBeNull();
    saveWorkChoice("routine");
    expect(readWorkChoice()).toBe("routine");
    saveWorkChoice(KEEP);
    expect(readWorkChoice()).toBe(KEEP);
    localStorage.setItem("kvistcode.workType", "gone");
    expect(readWorkChoice()).toBeNull();
  });
});

describe("the default pick", () => {
  it("is the recommended one on a fresh install", () => {
    expect(defaultWorkChoice(undefined)).toBe("everyday");
    expect(defaultWorkChoice({})).toBe("everyday");
    expect(defaultWorkChoice({ permissionMode: "plan" })).toBe("everyday");
  });

  it("leaves people who chose their own model or effort where they are", () => {
    expect(defaultWorkChoice({ model: "sonnet" })).toBe(KEEP);
    expect(defaultWorkChoice({ effort: "high" })).toBe(KEEP);
  });

  it("prefers the last pick when it is still on offer, else falls back", () => {
    expect(resolveWorkChoice("routine", {}, WORK_TYPES)).toBe("routine");
    expect(resolveWorkChoice(KEEP, {}, WORK_TYPES)).toBe(KEEP);
    expect(resolveWorkChoice(null, {}, WORK_TYPES)).toBe("everyday");
    expect(
      resolveWorkChoice(
        "big",
        {},
        WORK_TYPES.filter((w) => w.id !== "big"),
      ),
    ).toBe("everyday");
    // Nothing on offer fits: keep the usual rather than ask for a model that isn't there.
    expect(resolveWorkChoice(null, {}, [])).toBe(KEEP);
  });
});

describe("availableWorkTypes", () => {
  it("offers all of them with no Claude agent to look at", () => {
    expect(availableWorkTypes([])).toEqual(WORK_TYPES);
    expect(availableWorkTypes([agent({ provider: "codex" })])).toEqual(WORK_TYPES);
  });

  it("hides the ones whose model Claude Code does not offer", () => {
    const a = agent({ configOptions: [option("model", ["default", "opus", "sonnet", "haiku"])] });
    expect(availableWorkTypes([a]).map((w) => w.id)).toEqual(["everyday", "routine", "quick"]);
  });

  it("takes the models any Claude agent offers", () => {
    const a = agent({ configOptions: [option("model", ["opus"])] });
    const b = agent({ configOptions: [option("model", ["fable"])] });
    expect(availableWorkTypes([a, b]).map((w) => w.id)).toEqual(["everyday", "big"]);
  });
});

describe("hints", () => {
  it("explains effort levels and models for Claude only", () => {
    expect(choiceHint(agent(), option("effort", ["medium"]), "medium")).toMatch(/start/i);
    expect(choiceHint(agent(), option("model", ["fable"]), "fable")).toMatch(/refactor/i);
    expect(choiceHint(agent(), option("effort", ["weird"]), "weird")).toBeNull();
    expect(choiceHint(agent(), option("approval", ["a"]), "a")).toBeNull();
    expect(choiceHint(agent({ provider: "codex" }), option("effort", ["medium"]), "medium")).toBeNull();
  });

  it("adds a note under the effort and model menus of Claude agents", () => {
    expect(menuNote(agent(), option("effort", ["low"]))).toMatch(/effort/i);
    expect(menuNote(agent(), option("model", ["opus"]))).toMatch(/break/i);
    expect(menuNote(agent(), option("mode", ["x"]))).toBeNull();
    expect(menuNote(agent({ provider: "grok" }), option("model", ["x"]))).toBeNull();
  });
});

describe("switching models on a long conversation", () => {
  const model = option("model", ["opus", "sonnet"], "opus");
  it("only warns for a Claude model change at 100k tokens or more", () => {
    expect(switchNeedsNote(agent({ contextUsed: 100_000 }), model, "sonnet")).toBe(true);
    expect(switchNeedsNote(agent({ contextUsed: 99_999 }), model, "sonnet")).toBe(false);
    expect(switchNeedsNote(agent({ contextUsed: 150_000 }), model, "opus")).toBe(false);
    expect(switchNeedsNote(agent({ contextUsed: 150_000 }), option("effort", ["low", "high"]), "high")).toBe(false);
    expect(switchNeedsNote(agent({ provider: "codex", contextUsed: 150_000 }), model, "sonnet")).toBe(false);
  });
});
