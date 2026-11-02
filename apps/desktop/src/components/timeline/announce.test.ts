import { describe, expect, it } from "vitest";
import { announcementFor } from "./Timeline";

describe("announcementFor", () => {
  it("says what needs the user", () => {
    expect(announcementFor("agent_message", "Claude", "")).toBe("Claude replied");
    expect(announcementFor("permission", "Claude", "Edit src/a.ts")).toBe("Claude needs approval: Edit src/a.ts");
    expect(announcementFor("question", "Codex", "Which branch?")).toBe("Codex asks: Which branch?");
  });

  it("stays quiet for tool calls, thoughts and notices (a busy agent makes dozens)", () => {
    for (const k of ["tool_call", "thought", "notice", "plan", "user_message", "turn_summary"] as const)
      expect(announcementFor(k, "Claude", "Read x")).toBeNull();
  });
});
