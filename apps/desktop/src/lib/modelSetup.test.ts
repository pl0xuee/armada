import { beforeEach, describe, expect, it, vi } from "vitest";

let defaults: Record<string, Record<string, string>> = {};
const setConfigDefaults = vi.fn(async (key: string, values: Record<string, string>) => {
  const entry = { ...defaults[key] };
  for (const [k, v] of Object.entries(values)) {
    if (v) entry[k] = v;
    else delete entry[k];
  }
  defaults = { ...defaults, [key]: entry };
  return defaults;
});
vi.mock("./api", () => ({
  api: {
    configDefaults: async () => defaults,
    setConfigDefaults: (k: string, v: Record<string, string>) => setConfigDefaults(k, v),
  },
}));

import { readWorkChoice, saveWorkChoice } from "./modelGuide";
import {
  applySetup,
  describeSetup,
  readUndo,
  RECOMMENDED_SETUP,
  revertSetup,
  setupFrom,
  workChoiceFor,
  type SaveHelpers,
} from "./modelSetup";
import type { TokenSaverOptions } from "./types";

let saver: TokenSaverOptions;
const saveHelpers: SaveHelpers = async (patch) => {
  saver = { ...saver, ...patch };
  return true;
};

beforeEach(() => {
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
  defaults = {};
  setConfigDefaults.mockClear();
  saver = { outputFilter: false, bashOutputMaxChars: null, subagentModel: null, subagentEffort: null };
});

describe("the model setup", () => {
  it("reads what new agents start with now", () => {
    expect(setupFrom(null, undefined, saver)).toEqual({ ...RECOMMENDED_SETUP, helperModel: null });
    expect(
      setupFrom("keep", { model: "fable", effort: "high" }, { subagentModel: "haiku", subagentEffort: "low" }),
    ).toEqual({
      model: "fable",
      effort: "high",
      helperModel: "haiku",
      helperEffort: "low",
    });
  });

  it("maps a model and effort to a kind of work when one matches", () => {
    expect(workChoiceFor({ model: "opus", effort: "medium" })).toBe("everyday");
    expect(workChoiceFor({ model: "opus", effort: "high" })).toBe("keep");
  });

  it("applies a setup and reverts to exactly what was there", async () => {
    saveWorkChoice("routine");
    defaults = { claude: { effort: "low" } };
    saver = { ...saver, subagentModel: "haiku" };

    const pick = { model: "fable", effort: "high", helperModel: "sonnet", helperEffort: "medium" };
    expect(await applySetup(pick, saver, saveHelpers)).toBe(true);
    expect(defaults.claude).toEqual({ model: "fable", effort: "high" });
    expect(readWorkChoice()).toBe("keep");
    expect([saver.subagentModel, saver.subagentEffort]).toEqual(["sonnet", "medium"]);
    expect(readUndo()).not.toBeNull();

    expect(await revertSetup(saveHelpers)).toBe(true);
    expect(defaults.claude).toEqual({ effort: "low" });
    expect(readWorkChoice()).toBe("routine");
    expect([saver.subagentModel, saver.subagentEffort]).toEqual(["haiku", null]);
    expect(readUndo()).toBeNull();
    expect(await revertSetup(saveHelpers)).toBe(false);
  });

  it("changes nothing else when the helper settings can't be saved", async () => {
    expect(await applySetup(RECOMMENDED_SETUP, saver, async () => false)).toBe(false);
    expect(setConfigDefaults).not.toHaveBeenCalled();
    expect(readWorkChoice()).toBeNull();
    expect(readUndo()).toBeNull();
  });

  it("describes a setup in plain words", () => {
    expect(describeSetup(RECOMMENDED_SETUP)).toBe("Opus at medium effort, helpers on Sonnet");
    expect(describeSetup({ model: "haiku", effort: "low", helperModel: null, helperEffort: "low" })).toBe(
      "Haiku at low effort, helpers on the same model at low effort",
    );
  });
});
