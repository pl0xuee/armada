import { describe, expect, it } from "vitest";
import { useUi } from "./ui";

describe("home prompt", () => {
  it("survives a trip to another view", () => {
    useUi.getState().setHomePrompt("fix the login bug");
    useUi.getState().setView("accounts");
    useUi.getState().setView("agents");
    expect(useUi.getState().homePrompt).toBe("fix the login bug");
    useUi.getState().setHomePrompt("");
  });
});
