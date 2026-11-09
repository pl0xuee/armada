import { describe, expect, it } from "vitest";
import {
  companionOutcome,
  companionStatus,
  failureHint,
  groupCompanions,
  installExplanation,
  isWingetNothingToDo,
  missingRecommended,
} from "./companions";
import type { CompanionInfo } from "./types";

const c = (over: Partial<CompanionInfo>): CompanionInfo => ({
  id: "x",
  name: "X",
  group: "Essentials",
  purpose: "Does x.",
  recommended: false,
  installed: false,
  version: null,
  installable: true,
  installCommand: "apt-get install -y x",
  manager: "apt",
  downloadUrl: "https://example.com",
  ...over,
});

describe("groupCompanions", () => {
  it("groups by section in the order they first appear and keeps the tool order", () => {
    const list = [
      c({ id: "git", group: "Essentials" }),
      c({ id: "node", group: "Languages and build" }),
      c({ id: "gh", group: "Essentials" }),
      c({ id: "uv", group: "Languages and build" }),
      c({ id: "jq", group: "Search and shell" }),
    ];
    const g = groupCompanions(list);
    expect(g.map((x) => x.group)).toEqual(["Essentials", "Languages and build", "Search and shell"]);
    expect(g[0].items.map((i) => i.id)).toEqual(["git", "gh"]);
    expect(g[1].items.map((i) => i.id)).toEqual(["node", "uv"]);
  });

  it("is empty for an empty list", () => {
    expect(groupCompanions([])).toEqual([]);
  });
});

describe("missingRecommended", () => {
  it("returns only recommended tools that are not installed", () => {
    const list = [
      c({ id: "git", recommended: true }),
      c({ id: "gh", recommended: true, installed: true }),
      c({ id: "jq" }),
    ];
    expect(missingRecommended(list).map((i) => i.id)).toEqual(["git"]);
  });
});

describe("companionStatus", () => {
  it("shows the version when there is one", () => {
    expect(companionStatus(c({ installed: true, version: "2.45.2" }))).toBe("Installed · v2.45.2");
    expect(companionStatus(c({ installed: true }))).toBe("Installed");
    expect(companionStatus(c({}))).toBe("Not installed");
  });
});

describe("installExplanation", () => {
  it("names the tool and the manager and mentions the password", () => {
    const text = installExplanation(c({ name: "Git", manager: "Homebrew" }));
    expect(text).toContain("install Git with Homebrew");
    expect(text).toContain("password");
  });
  it("leaves the manager out when unknown", () => {
    expect(installExplanation(c({ name: "Git", manager: null }))).not.toContain(" with ");
  });
});

describe("winget exits that mean nothing to do", () => {
  it("knows already installed and no applicable upgrade, signed or unsigned", () => {
    expect(isWingetNothingToDo("winget", 0x8a150061)).toBe(true);
    expect(isWingetNothingToDo("winget", 0x8a15002b)).toBe(true);
    expect(isWingetNothingToDo("winget", -1978335135)).toBe(true); // 0x8A150061 as a signed 32-bit number
    expect(isWingetNothingToDo("winget", -1978335189)).toBe(true); // 0x8A15002B
  });
  it("is not true for other codes, other managers or no code", () => {
    expect(isWingetNothingToDo("winget", 1)).toBe(false);
    expect(isWingetNothingToDo("winget", 0)).toBe(false);
    expect(isWingetNothingToDo("apt", 0x8a150061)).toBe(false);
    expect(isWingetNothingToDo("winget", null)).toBe(false);
    expect(isWingetNothingToDo(null, 0x8a150061)).toBe(false);
  });
});

describe("failure hint", () => {
  it("tells Linux package-manager users to update the package list", () => {
    for (const m of ["apt", "dnf", "pacman", "zypper"]) {
      expect(failureHint(m)).toBe(
        "If it says it can't find the package, update your package list first (for example: sudo apt update) and try again.",
      );
    }
    for (const m of ["Homebrew", "winget", "apk", null]) expect(failureHint(m)).toBeNull();
  });
});

describe("companionOutcome", () => {
  const here = c({ installed: true, version: "1.2.3" });
  const missing = c({ installed: false });
  it("is ready when the installer succeeded and the tool is there", () => {
    expect(companionOutcome(here, "apt", 0)).toEqual({ kind: "ready" });
  });
  it("is stopped when the person stopped it", () => {
    expect(companionOutcome(missing, "apt", 130)).toEqual({ kind: "stopped" });
    expect(companionOutcome(missing, "apt", 143)).toEqual({ kind: "stopped" });
  });
  it("says the tool isn't visible yet when the installer succeeded but it is not found", () => {
    const o = companionOutcome(missing, "apt", 0);
    expect(o.kind).toBe("not-visible");
  });
  it("counts winget's already-installed exit as success, with a restart hint if it is still missing", () => {
    expect(companionOutcome(here, "winget", 0x8a150061)).toEqual({ kind: "ready" });
    const o = companionOutcome(missing, "winget", -1978335135);
    expect(o).toMatchObject({ kind: "not-visible", description: expect.stringMatching(/restart Kvistcode/) });
  });
  it("fails with the package-list hint on Linux and without it elsewhere", () => {
    const apt = companionOutcome(missing, "apt", 100);
    expect(apt).toMatchObject({ kind: "failed", description: expect.stringMatching(/sudo apt update/) });
    const brew = companionOutcome(missing, "Homebrew", 1);
    expect(brew.kind === "failed" && brew.description).not.toMatch(/apt update/);
  });
});
