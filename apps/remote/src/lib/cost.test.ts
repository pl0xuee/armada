import { describe, expect, it, vi } from "vitest";
import { holdText, SUBSCRIPTION_HOLD_HINT } from "./budgetHold";
import { costIsEquivalent } from "./cost";

// The controller reads the page address when it loads.
vi.stubGlobal("location", { hash: "", search: "", pathname: "/" });
const { toRemoteAccount } = await import("./controller");

describe("a subscription's cost is API-equivalent, not a bill", () => {
  const claude = { provider: "claude" as const };
  it("says so for oauth and default sign-ins, not for API keys or local models", () => {
    expect(costIsEquivalent(claude, { authKind: "oauth" })).toBe(true);
    expect(costIsEquivalent(claude, { authKind: "default" })).toBe(true);
    expect(costIsEquivalent(claude, { authKind: "api_key" })).toBe(false);
    expect(costIsEquivalent({ provider: "local" }, { authKind: "oauth" })).toBe(false);
  });

  it("never guesses: no account (share link) or no kind (older server) says nothing", () => {
    expect(costIsEquivalent(claude, undefined)).toBe(false);
    expect(costIsEquivalent(claude, {})).toBe(false);
  });

  it("the hold sentence carries the note only for a cost limit", () => {
    const cost = { scope: "agent", metric: "cost", spent: 5.1, cap: 5 };
    expect(holdText(cost, true)).toBe("Reached its own limit: $5.10 of $5.00 (API-equivalent cost, not a bill).");
    expect(holdText(cost)).toBe("Reached its own limit: $5.10 of $5.00.");
    expect(holdText({ scope: "agent", metric: "turns", spent: 20, cap: 20 }, true)).toBe("Reached its own limit: 20 of 20 turns.");
    expect(SUBSCRIPTION_HOLD_HINT).toContain("turn or token limit");
  });

  it("the account kind survives an account_updated event", () => {
    const a = toRemoteAccount({ id: "x", name: "X", provider: "claude", color: "#fff", authKind: "api_key", status: null });
    expect(a?.authKind).toBe("api_key");
    expect(toRemoteAccount({ id: "x", name: "X", provider: "claude", authKind: "weird" })).not.toHaveProperty("authKind");
  });
});
