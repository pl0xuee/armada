import { describe, expect, it } from "vitest";
import {
  canInstall,
  canRollBack,
  compareVersions,
  isNewerVersion,
  lastChecked,
  toolSource,
  toolStatus,
  updateCount,
  versionParts,
} from "./toolVersions";
import { seedProviders } from "./mock-data";
import type { ProviderInfo } from "./types";

const [claude, codex, grok] = seedProviders();
const with_ = (p: ProviderInfo, patch: Partial<ProviderInfo>): ProviderInfo => ({ ...p, ...patch });

describe("compareVersions", () => {
  it("compares numerically, not as text", () => {
    expect(compareVersions("0.166.0", "0.165.0")).toBeGreaterThan(0);
    expect(compareVersions("0.99.0", "0.100.0")).toBeLessThan(0);
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
  });
  it("treats missing parts as zero and ignores a v prefix or suffix", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("v2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.4.1-beta.2", "0.4.1")).toBe(0);
  });
  it("calls unparsable versions equal", () => {
    expect(compareVersions("latest", "1.0.0")).toBe(0);
    expect(isNewerVersion("latest", "1.0.0")).toBe(false);
  });
  it("isNewerVersion needs both sides", () => {
    expect(isNewerVersion("1.0.1", "1.0.0")).toBe(true);
    expect(isNewerVersion(null, "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.1", null)).toBe(false);
  });
});

describe("canRollBack", () => {
  it("only when Armada's copy is newer than the tested version", () => {
    expect(canRollBack(with_(codex, { managedVersion: "0.166.0" }))).toBe(true);
    expect(canRollBack(codex)).toBe(false);
    expect(canRollBack(with_(codex, { managedVersion: "0.160.0" }))).toBe(false);
    expect(canRollBack(with_(codex, { managedVersion: "0.166.0", managed: false }))).toBe(false);
    expect(canRollBack(with_(codex, { managedVersion: "0.166.0", testedVersion: null }))).toBe(false);
  });
});

describe("toolStatus / toolSource", () => {
  it("bundled and up to date", () => {
    expect(toolSource(claude)).toBe("bundled");
    expect(toolStatus(claude)).toEqual({ kind: "uptodate", label: "Up to date" });
  });
  it("update available names the version", () => {
    expect(toolStatus(codex)).toEqual({ kind: "update", label: "Update available → 0.166.0" });
    expect(toolStatus(with_(codex, { latestVersion: null })).label).toBe("Update available");
  });
  it("a system install is being set up", () => {
    expect(toolSource(grok)).toBe("system");
    expect(toolStatus(grok)).toEqual({ kind: "setup", label: "Setting up…" });
  });
  it("nothing installed", () => {
    const none = with_(grok, { installed: false, version: null, path: null });
    expect(toolSource(none)).toBe("none");
    expect(toolStatus(none)).toEqual({ kind: "missing", label: "Not installed" });
  });
});

describe("canInstall", () => {
  it("offers Install when nothing is installed or the adapter is missing", () => {
    expect(canInstall(with_(grok, { installed: false }))).toBe(true);
    expect(canInstall(with_(claude, { managed: false, adapterInstalled: false }))).toBe(true);
  });
  it("not for a working system install (Armada sets up its own) or a bundled copy", () => {
    expect(canInstall(grok)).toBe(false);
    expect(canInstall(codex)).toBe(false);
  });
});

describe("versionParts", () => {
  it("shows installed, latest and tested", () => {
    expect(versionParts(codex)).toEqual(["Installed 0.165.0", "Latest 0.166.0", "Tested 0.165.0"]);
  });
  it("Claude shows Claude Code and the adapter", () => {
    expect(versionParts(claude)).toEqual(["Claude Code 2.1.310", "Adapter 0.98.0", "Latest 0.98.0", "Tested 0.98.0"]);
  });
  it("hides what is unknown", () => {
    const bare = with_(codex, { managedVersion: null, version: null, latestVersion: null, testedVersion: null });
    expect(versionParts(bare)).toEqual([]);
    expect(versionParts(grok)).toEqual(["Installed 0.4.1", "Latest 0.4.2", "Tested 0.4.1"]);
  });
});

describe("updateCount / lastChecked", () => {
  it("counts bundled tools with an update", () => {
    expect(updateCount([claude, codex, grok])).toBe(1);
    expect(updateCount([with_(grok, { updateAvailable: true })])).toBe(0);
  });
  it("takes the newest check time", () => {
    expect(
      lastChecked([
        with_(claude, { updatesCheckedAt: 5 }),
        with_(codex, { updatesCheckedAt: 9 }),
        with_(grok, { updatesCheckedAt: null }),
      ]),
    ).toBe(9);
    expect(lastChecked([with_(claude, { updatesCheckedAt: null })])).toBeNull();
    expect(lastChecked([])).toBeNull();
  });
});
