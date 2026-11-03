import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrStatus } from "@/lib/types";

const calls: { force: boolean; resolve: (s: PrStatus) => void }[] = [];
vi.mock("@/lib/api", () => ({
  api: {
    prStatus: (_id: string, force: boolean) => new Promise<PrStatus>((resolve) => calls.push({ force, resolve })),
  },
}));

import { refreshPr, usePr } from "./pr";

const status = (title: string) => ({ state: "ok", title }) as unknown as PrStatus;

describe("refreshPr", () => {
  beforeEach(() => {
    calls.length = 0;
    usePr.setState({ byAgent: {} });
  });

  it("drops a slow older response that arrives after a newer forced one", async () => {
    const slow = refreshPr("a", false);
    const fresh = refreshPr("a", true);
    calls[1].resolve(status("fresh"));
    await fresh;
    calls[0].resolve(status("stale"));
    await slow;
    expect((usePr.getState().byAgent.a as unknown as { title: string }).title).toBe("fresh");
  });

  it("applies responses that arrive in order", async () => {
    const first = refreshPr("b", false);
    calls[0].resolve(status("one"));
    await first;
    const second = refreshPr("b", true);
    calls[1].resolve(status("two"));
    await second;
    expect((usePr.getState().byAgent.b as unknown as { title: string }).title).toBe("two");
  });
});
