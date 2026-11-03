import { describe, expect, it } from "vitest";
import type { Agent, ConfigOption } from "@/lib/types";
import { plainConfigOptions } from "./composerModes";

const opt = (id: string, values: [string, string][]): ConfigOption => ({
  id,
  name: "Mode",
  category: "mode",
  currentValue: values[0][0],
  options: values.map(([value, name]) => ({ value, name, description: null })),
});
const agentOf = (provider: Agent["provider"], configOptions: ConfigOption[]) =>
  ({ provider, configOptions }) as unknown as Agent;

describe("plainConfigOptions", () => {
  it("renames Claude's default and bypass modes, keeping values and the exact name in the hint", () => {
    const [o] = plainConfigOptions(
      agentOf("claude", [
        opt("mode", [
          ["default", "Ask before edits"],
          ["plan", "Plan mode"],
          ["bypassPermissions", "Bypass permissions"],
        ]),
      ]),
    );
    expect(o.options.map((c) => c.value)).toEqual(["default", "plan", "bypassPermissions"]);
    expect(o.options.map((c) => c.name)).toEqual(["Ask before changes", "Plan mode", "Run without asking"]);
    expect(o.options[0].description).toBe("“Ask before edits”");
  });

  it("maps Codex's approval policies", () => {
    const [o] = plainConfigOptions(
      agentOf("codex", [
        opt("approval", [
          ["untrusted", "Ask for most actions"],
          ["on-request", "Auto"],
          ["never", "Never ask"],
        ]),
      ]),
    );
    expect(o.options.map((c) => c.name)).toEqual(["Ask before changes", "Run without asking", "Never ask"]);
  });

  it("leaves other options and custom agents alone", () => {
    const options = [opt("model", [["a", "Opus"]])];
    expect(plainConfigOptions(agentOf("claude", options))[0]).toBe(options[0]);
    const custom = [opt("mode", [["default", "Default"]])];
    expect(plainConfigOptions(agentOf("custom", custom))).toBe(custom);
  });
});
