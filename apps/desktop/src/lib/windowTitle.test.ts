import { describe, expect, it } from "vitest";
import { seedAgents } from "./mock-data";
import { windowTitle } from "./windowTitle";

const a = { ...seedAgents()[0], title: "Fix login" };

describe("windowTitle", () => {
  it("is plain without an agent or when idle and not done", () => {
    expect(windowTitle(undefined, false)).toBe("Armada");
    expect(windowTitle({ ...a, status: "idle" }, false)).toBe("Armada");
  });
  it("reflects working, approval and done", () => {
    expect(windowTitle({ ...a, status: "working" }, false)).toBe("● Working — Fix login · Armada");
    expect(windowTitle({ ...a, status: "needs_permission" }, false)).toBe("⚠ Needs approval — Fix login · Armada");
    expect(windowTitle({ ...a, status: "idle" }, true)).toBe("✓ Done — Fix login · Armada");
  });
});
