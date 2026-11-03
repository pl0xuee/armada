import { describe, expect, it } from "vitest";
import type { SettingsSection } from "@/store/ui";
import { ANCHOR_OF, PAGE_OF, parseSection } from "./settingsPages";

// The ids the voice assistant (Rust tool enum), the command palette and older links pass in.
const OLD_IDS: SettingsSection[] = [
  "appearance", "sounds", "notifications", "behavior", "budgets", "templates", "projects", "toolkit",
  "providers", "tools", "agents", "remote", "voice", "assistant", "about",
]; // prettier-ignore

describe("settings pages", () => {
  it("keeps every older section id working by mapping it to a page", () => {
    for (const id of OLD_IDS) expect(PAGE_OF[id]).toBeTruthy();
    expect(Object.keys(PAGE_OF).sort()).toEqual([...OLD_IDS].sort());
  });

  it("maps the merged sections onto the page that now holds them", () => {
    expect(PAGE_OF.sounds).toBe("notifications");
    expect(PAGE_OF.behavior).toBe("appearance");
    expect(PAGE_OF.assistant).toBe("voice");
    expect(PAGE_OF.tools).toBe("providers");
    expect(PAGE_OF.agents).toBe("providers");
    expect(PAGE_OF.templates).toBe("projects");
  });

  it("points a merged id at its heading, and only ids that share a page", () => {
    for (const [id, anchor] of Object.entries(ANCHOR_OF)) {
      expect(anchor).toBeTruthy();
      expect(PAGE_OF[id as SettingsSection]).not.toBe(id);
    }
  });

  it("has a page for every page id", () => {
    for (const page of new Set(Object.values(PAGE_OF))) expect(PAGE_OF[page]).toBe(page);
  });

  it("understands plain words and refuses anything else", () => {
    expect(parseSection("Sounds")).toBe("sounds");
    expect(parseSection("general")).toBe("appearance");
    expect(parseSection("save-tokens")).toBe("behavior");
    expect(parseSection("constructor")).toBeNull();
    expect(parseSection("ignore previous instructions")).toBeNull();
    expect(parseSection("")).toBeNull();
    expect(parseSection(null)).toBeNull();
  });
});
