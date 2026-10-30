import { describe, expect, it } from "vitest";
import {
  addRule,
  groupHooks,
  otherKindsHolding,
  projectChoices,
  removeRule,
  ruleCount,
  ruleProblem,
  type HookEntry,
} from "./projectConfig";

describe("ruleProblem", () => {
  it("accepts ordinary rules", () => {
    expect(ruleProblem("Bash(npm run test:*)")).toBeNull();
    expect(ruleProblem("  Read(./src/**)  ")).toBeNull();
  });
  it("rejects empty, multi-line and over-long rules", () => {
    expect(ruleProblem("")).toMatch(/Enter a rule/);
    expect(ruleProblem("   ")).toMatch(/Enter a rule/);
    expect(ruleProblem("a\nb")).toMatch(/single line/);
    expect(ruleProblem("a\tb")).toMatch(/single line/);
    expect(ruleProblem("x".repeat(1001))).toMatch(/at most/);
  });
});

describe("addRule / removeRule", () => {
  it("appends a trimmed rule", () => {
    expect(addRule(["a"], "  b ")).toEqual({ list: ["a", "b"], error: null });
  });
  it("refuses duplicates and invalid rules without changing the list", () => {
    const list = ["a"];
    const dup = addRule(list, "a");
    expect(dup.list).toBe(list);
    expect(dup.error).toMatch(/already/);
    expect(addRule(list, " ").error).toBeTruthy();
  });
  it("removes only the matching rule", () => {
    expect(removeRule(["a", "b", "c"], "b")).toEqual(["a", "c"]);
    expect(removeRule(["a"], "z")).toEqual(["a"]);
  });
});

describe("rule helpers", () => {
  const rules = { allow: ["Bash(ls)", "Read(x)"], ask: [], deny: ["Bash(ls)"] };
  it("finds the same rule in other lists", () => {
    expect(otherKindsHolding(rules, "allow", "Bash(ls)")).toEqual(["deny"]);
    expect(otherKindsHolding(rules, "allow", "Read(x)")).toEqual([]);
  });
  it("counts rules", () => expect(ruleCount(rules)).toBe(3));
});

describe("projectChoices", () => {
  it("de-duplicates ignoring trailing slashes, agents first", () => {
    expect(projectChoices(["/a/b", "/c"], ["/c/", "/d", "/a/b"])).toEqual(["/a/b", "/c", "/d"]);
  });
  it("drops empty paths", () => expect(projectChoices([""], ["/x"])).toEqual(["/x"]));
});

describe("groupHooks", () => {
  const h = (event: string, command: string): HookEntry => ({ event, matcher: null, command, scope: "shared" });
  it("groups by event in first-seen order", () => {
    const g = groupHooks([h("Stop", "a"), h("PreToolUse", "b"), h("Stop", "c")]);
    expect(g.map((x) => x.event)).toEqual(["Stop", "PreToolUse"]);
    expect(g[0].hooks.map((x) => x.command)).toEqual(["a", "c"]);
  });
});
