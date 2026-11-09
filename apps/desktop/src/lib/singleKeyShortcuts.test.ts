import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSingleKeyShortcuts, shouldIgnoreApprovalKey } from "./approvalKeys";

// The unit tests run in node (no DOM), so stub the two globals the helper reads.
const key = (k: string) => ({ key: k, target: null }) as unknown as KeyboardEvent;

describe("one-letter shortcuts setting", () => {
  beforeEach(() => {
    vi.stubGlobal("HTMLElement", class {});
    vi.stubGlobal("document", { querySelector: () => null });
  });
  afterEach(() => {
    setSingleKeyShortcuts(true);
    vi.unstubAllGlobals();
  });

  it("approval keys work by default", () => {
    expect(shouldIgnoreApprovalKey(key("a"))).toBe(false);
  });

  it("are ignored everywhere once turned off", () => {
    setSingleKeyShortcuts(false);
    expect(shouldIgnoreApprovalKey(key("a"))).toBe(true);
    expect(shouldIgnoreApprovalKey(key("1"))).toBe(true);
  });
});
