import { describe, expect, it } from "vitest";
import { seedSettings } from "@/lib/mock-data";
import { useApp } from "./app";

describe("settings changed from the phone", () => {
  it("replaces the window's copy, so a later save doesn't put the old value back", () => {
    const settings = seedSettings(true);
    useApp.setState({ settings: { ...settings, responseStyle: "concise" } });
    useApp.getState().applyEvent({ type: "settings_changed", settings: { ...settings, responseStyle: "detailed" } });
    expect(useApp.getState().settings?.responseStyle).toBe("detailed");
  });
});
