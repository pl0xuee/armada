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
  otherProviders,
  othersFrom,
  readUndo,
  RECOMMENDED_SETUP,
  revertSetup,
  sameSetup,
  setupFrom,
  workChoiceFor,
  type SaveHelpers,
} from "./modelSetup";
import type { Agent, ConfigOption, CustomAgent, ProviderInfo, TokenSaverOptions } from "./types";

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
      others: {},
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

    const pick = { model: "fable", effort: "high", helperModel: "sonnet", helperEffort: "medium", others: {} };
    expect(await applySetup(pick, saver, saveHelpers)).not.toBeNull();
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
    expect(await applySetup(RECOMMENDED_SETUP, saver, async () => false)).toBeNull();
    expect(setConfigDefaults).not.toHaveBeenCalled();
    expect(readWorkChoice()).toBeNull();
    expect(readUndo()).toBeNull();
  });

  it("describes a setup in plain words", () => {
    expect(describeSetup(RECOMMENDED_SETUP)).toBe("Opus at medium effort, helpers on Sonnet");
    expect(describeSetup({ model: "haiku", effort: "low", helperModel: null, helperEffort: "low", others: {} })).toBe(
      "Haiku at low effort, helpers on the same model at low effort",
    );
  });
});

const option = (id: string, category: string | null, values: string[]): ConfigOption => ({
  id,
  name: id,
  category,
  currentValue: values[0],
  options: values.map((value) => ({ value, name: value.toUpperCase(), description: null })),
});

const agent = (over: Partial<Agent>): Agent =>
  ({ provider: "codex", customAgentId: null, parentId: null, lastActivityAt: 1, configOptions: [], ...over }) as Agent;

const codexOptions = [
  option("model", "model", ["gpt-5.5", "gpt-5.5-mini"]),
  option("effort", "thought_level", ["low", "high"]),
  option("approval", "mode", ["on-request", "never"]),
];

describe("other providers", () => {
  const gemini: CustomAgent = {
    id: "ca-gemini",
    name: "Gemini CLI",
    command: "gemini",
    args: [],
    env: [],
    color: "#4285f4",
    enabled: true,
  };
  const off: CustomAgent = { ...gemini, id: "ca-off", name: "Off", enabled: false };
  const installed = (p: string) => ({ provider: p, installed: true }) as ProviderInfo;

  it("lists Codex, Grok and enabled custom agents with the models their latest agent offers", () => {
    const agents = [
      agent({ lastActivityAt: 1, configOptions: [option("model", "model", ["old"])] }),
      agent({ lastActivityAt: 5, configOptions: codexOptions }),
      agent({ lastActivityAt: 9, parentId: "x", configOptions: [option("model", "model", ["helper"])] }),
      agent({
        provider: "custom",
        customAgentId: "ca-gemini",
        configOptions: [option("model", "model", ["gemini-3-pro"]), option("thinking", null, ["on", "off"])],
      }),
    ];
    const list = otherProviders(agents, [installed("grok"), installed("claude")], [gemini, off]);
    expect(list.map((p) => p.key)).toEqual(["codex", "grok", "custom:ca-gemini"]);
    const [codex, grok, gem] = list;
    expect(codex.model?.options.map((o) => o.value)).toEqual(["gpt-5.5", "gpt-5.5-mini"]);
    expect(codex.effort?.id).toBe("effort");
    expect([grok.model, grok.effort]).toEqual([null, null]);
    expect([codex.seen, grok.seen, gem.seen]).toEqual([true, false, true]);
    expect(gem.name).toBe("Gemini CLI");
    expect([gem.model?.id, gem.effort?.id]).toEqual(["model", "thinking"]);
  });

  it("leaves out a provider that is neither installed nor used", () => {
    expect(otherProviders([], [], [])).toEqual([]);
  });

  it("reads, applies and reverts every provider's choices together", async () => {
    defaults = { codex: { model: "gpt-5.5", approval: "on-request" } };
    const list = otherProviders([agent({ configOptions: codexOptions })], [], []);
    const now = othersFrom(defaults, list);
    expect(now).toEqual({ codex: { model: "gpt-5.5", effort: "" } });

    const before = { ...setupFrom(null, undefined, saver), others: now };
    const pick = { ...before, others: { codex: { model: "gpt-5.5-mini", effort: "high" } } };
    expect(sameSetup(before, pick)).toBe(false);
    expect(sameSetup(before, { ...before, others: { codex: { model: "gpt-5.5" } } })).toBe(true);

    expect(await applySetup(pick, saver, saveHelpers)).not.toBeNull();
    expect(defaults.codex).toEqual({ model: "gpt-5.5-mini", effort: "high", approval: "on-request" });

    expect(await revertSetup(saveHelpers)).toBe(true);
    expect(defaults.codex).toEqual({ model: "gpt-5.5", approval: "on-request" });
    expect(defaults.claude).toEqual({});
  });
});

describe("saving only what changed", () => {
  it("leaves Claude alone when only another provider changed", async () => {
    saveWorkChoice("routine");
    const before = { ...setupFrom(null, undefined, saver), others: { codex: { model: "" } } };
    const pick = { ...before, others: { codex: { model: "gpt-5.5-mini" } } };
    const helpers = vi.fn(saveHelpers);
    expect(await applySetup(pick, saver, helpers, before)).not.toBeNull();
    expect(helpers).not.toHaveBeenCalled();
    expect(defaults).toEqual({ codex: { model: "gpt-5.5-mini" } });
    expect(readWorkChoice()).toBe("routine");

    expect(await revertSetup(saveHelpers)).toBe(true);
    expect(defaults).toEqual({ codex: {} });
    expect(readWorkChoice()).toBe("routine");
  });

  it("an old Undo can't undo a newer change", async () => {
    const first = await applySetup({ ...RECOMMENDED_SETUP, model: "sonnet" }, saver, saveHelpers);
    const second = await applySetup({ ...RECOMMENDED_SETUP, model: "haiku" }, saver, saveHelpers);
    expect(first).not.toBe(second);
    expect(await revertSetup(saveHelpers, first!)).toBe(false);
    expect(defaults.claude.model).toBe("haiku");
    expect(await revertSetup(saveHelpers, second!)).toBe(true);
    expect(defaults.claude.model).toBe("sonnet");
  });

  it("a change that fails keeps the Revert that was there", async () => {
    await applySetup({ ...RECOMMENDED_SETUP, model: "sonnet" }, saver, saveHelpers);
    const kept = readUndo();
    expect(await applySetup(RECOMMENDED_SETUP, saver, async () => false)).toBeNull();
    expect(readUndo()).toEqual(kept);
  });
});
