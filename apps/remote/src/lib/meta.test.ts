import { describe, expect, it } from "vitest";
import { isDenyAndStop, optionHint, OPTION_HINT } from "./meta";
import type { PermissionOption } from "./types";

const opt = (id: string, kind: PermissionOption["kind"], name = id): PermissionOption => ({ id, name, kind });

describe("optionHint", () => {
  it("describes Codex's cancel as stopping the turn, not as a standing rule", () => {
    const cancel = opt("cancel", "reject_always", "Deny and stop");
    expect(isDenyAndStop(cancel)).toBe(true);
    expect(optionHint(cancel)).toBe("Deny and stop this turn");
  });
  it("describes other options by kind", () => {
    expect(optionHint(opt("reject_always", "reject_always", "Always deny"))).toBe(OPTION_HINT.reject_always);
    expect(optionHint(opt("accept", "allow_once"))).toBe(OPTION_HINT.allow_once);
    expect(isDenyAndStop(opt("cancel", "reject_once"))).toBe(false);
  });
});
