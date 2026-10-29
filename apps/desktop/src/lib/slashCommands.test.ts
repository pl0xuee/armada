import { describe, expect, it } from "vitest";
import { commandInitials, commandRank, expandCommandShortcut } from "./slashCommands";
import type { SlashCommand } from "./types";

const cmd = (name: string): SlashCommand => ({ name, description: null, hint: null });
const commands = ["remote-control", "compact", "review", "security-review", "release-notes", "mcp"].map(cmd);

describe("slash command shortcuts", () => {
  it("takes the first letter of each word", () => {
    expect(commandInitials("remote-control")).toBe("rc");
    expect(commandInitials("output-style:new")).toBe("osn");
    expect(commandInitials("compact")).toBe("c");
  });

  it("finds a command by its name, then its initials", () => {
    expect(commandRank("remote-control", "rc")).toBe(1);
    expect(commandRank("remote-control", "rem")).toBe(0);
    expect(commandRank("security-review", "review")).toBe(2);
    expect(commandRank("compact", "rc")).toBeNull();
    expect(commandRank("compact", "c")).toBe(0);
    // A single letter only matches names, not every command with that initial.
    expect(commandRank("remote-control", "c")).toBe(2);
  });

  it("expands a typed shortcut to the full command", () => {
    expect(expandCommandShortcut("/rc", commands)).toBe("/remote-control");
    expect(expandCommandShortcut("/rc my laptop", commands)).toBe("/remote-control my laptop");
    expect(expandCommandShortcut("/rc off", commands)).toBe("/remote-control off");
    expect(expandCommandShortcut("/RC", commands)).toBe("/remote-control");
  });

  it("leaves everything else alone", () => {
    expect(expandCommandShortcut("/compact", commands)).toBe("/compact");
    expect(expandCommandShortcut("/mcp", commands)).toBe("/mcp");
    // Ambiguous: release-notes and remote-control would both be "r?"; "rn" is only one.
    expect(expandCommandShortcut("/rn", commands)).toBe("/release-notes");
    expect(expandCommandShortcut("/r", commands)).toBe("/r");
    expect(expandCommandShortcut("please /rc", commands)).toBe("please /rc");
    expect(expandCommandShortcut("/rc", [cmd("rc"), cmd("remote-control")])).toBe("/rc");
    expect(expandCommandShortcut("/rc", [cmd("remote-control"), cmd("run-checks")])).toBe("/rc");
    expect(expandCommandShortcut("/rcx", commands)).toBe("/rcx");
    expect(expandCommandShortcut("hello", commands)).toBe("hello");
  });
});
