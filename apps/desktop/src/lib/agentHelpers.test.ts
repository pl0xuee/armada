import { describe, expect, it } from "vitest";
import { agentHelpers, ownsHelpers } from "./agentHelpers";

describe("agentHelpers", () => {
  const setting = { subagentModel: "sonnet", subagentEffort: "low" };

  it("follows the settings when the agent has no choice of its own", () => {
    expect(agentHelpers({}, setting)).toEqual({ model: "sonnet", effort: "low" });
    expect(agentHelpers({ subagentModel: null, subagentEffort: null }, setting)).toEqual({
      model: "sonnet",
      effort: "low",
    });
    expect(agentHelpers(undefined, null)).toEqual({ model: null, effort: null });
    expect(ownsHelpers({})).toBe(false);
  });

  it("uses the agent's own choice, where same and auto mean no override", () => {
    expect(agentHelpers({ subagentModel: "haiku", subagentEffort: "max" }, setting)).toEqual({
      model: "haiku",
      effort: "max",
    });
    expect(agentHelpers({ subagentModel: "same", subagentEffort: "auto" }, setting)).toEqual({
      model: null,
      effort: null,
    });
    expect(agentHelpers({ subagentModel: "haiku" }, setting)).toEqual({ model: "haiku", effort: "low" });
    expect(ownsHelpers({ subagentEffort: "auto" })).toBe(true);
  });
});
