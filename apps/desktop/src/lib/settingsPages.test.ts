import { describe, expect, it } from "vitest";
import type { SettingsSection } from "@/store/ui";
import {
  ANCHOR_OF,
  NAV_GROUPS,
  PAGE_LABEL,
  PAGE_OF,
  parseSection,
  searchSettings,
  SETTINGS_INDEX,
} from "./settingsPages";

// The ids the voice assistant (Rust tool enum), the command palette and older links pass in.
const OLD_IDS: SettingsSection[] = [
  "appearance", "sounds", "notifications", "behavior", "budgets", "templates", "projects", "toolkit",
  "providers", "tools", "agents", "remote", "voice", "assistant", "about", "keyboard", "models",
]; // prettier-ignore

describe("settings pages", () => {
  it("keeps every older section id working by mapping it to a page", () => {
    for (const id of OLD_IDS) expect(PAGE_OF[id]).toBeTruthy();
    expect(Object.keys(PAGE_OF).sort()).toEqual([...OLD_IDS].sort());
  });

  it("maps the merged sections onto the page that now holds them", () => {
    expect(PAGE_OF.sounds).toBe("notifications");
    expect(PAGE_OF.behavior).toBe("behavior");
    expect(PAGE_OF.budgets).toBe("models");
    expect(PAGE_OF.assistant).toBe("voice");
    expect(PAGE_OF.tools).toBe("providers");
    expect(PAGE_OF.agents).toBe("providers");
    expect(PAGE_OF.toolkit).toBe("projects");
    expect(PAGE_OF.templates).toBe("templates");
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
    expect(parseSection("save-tokens")).toBe("models");
    expect(parseSection("constructor")).toBeNull();
    expect(parseSection("ignore previous instructions")).toBeNull();
    expect(parseSection("")).toBeNull();
    expect(parseSection(null)).toBeNull();
  });
});

describe("the settings sidebar", () => {
  it("lists every page once, in a group", () => {
    const pages = NAV_GROUPS.flatMap((g) => g.pages);
    expect(new Set(pages).size).toBe(pages.length);
    expect([...pages].sort()).toEqual(Object.keys(PAGE_LABEL).sort());
    expect([...new Set(Object.values(PAGE_OF))].sort()).toEqual([...pages].sort());
  });

  it("keeps the old page names out of the labels", () => {
    expect(Object.values(PAGE_LABEL)).not.toContain("Tools & instructions");
    expect(PAGE_LABEL.models).toBe("Models & spending");
  });
});

describe("settings search", () => {
  it("finds a setting by its name, page or keywords", () => {
    expect(searchSettings("quiet")[0]).toMatchObject({ label: "Quiet hours", page: "notifications" });
    expect(searchSettings("ntfy")[0]).toMatchObject({ label: "Phone push", page: "remote", anchor: "push" });
    expect(searchSettings("claude.md")[0]).toMatchObject({ page: "projects", tab: "instructions" });
    expect(searchSettings("budget")[0]).toMatchObject({ page: "models", anchor: "budgets" });
  });

  it("needs every word to start a word, and ranks name matches first", () => {
    expect(searchSettings("ours")).toEqual([]);
    expect(searchSettings("rate lim")[0].label).toBe("Rate limits");
    expect(searchSettings("helper")[0].label).toBe("Helper agents");
  });

  it("finds nothing for an empty or odd query, and caps the list", () => {
    expect(searchSettings("   ")).toEqual([]);
    expect(searchSettings("(.*")).toEqual([]);
    expect(searchSettings("a", 3).length).toBeLessThanOrEqual(3);
  });

  it("only points at pages that exist", () => {
    for (const e of SETTINGS_INDEX) expect(PAGE_LABEL[e.page]).toBeTruthy();
  });
});
