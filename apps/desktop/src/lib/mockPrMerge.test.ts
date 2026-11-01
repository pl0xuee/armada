import { describe, expect, it } from "vitest";
import { isBranchChanged } from "./ghError";
import { mockApi } from "./mock";

// The browser mock stands in for the Rust command: a merge pinned to a commit that is no longer
// the head must be refused with the branch-changed message, and nothing merged.
describe("mock pr_merge pins the reviewed commit", () => {
  it("merges the commit that was shown, and refuses one that moved", async () => {
    const before = (await mockApi.prStatus("a-billing")).pr!;
    expect(before.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(before.state).toBe("open");

    (globalThis as { __kvistcodeMockPush?: (id: string) => void }).__kvistcodeMockPush!("a-billing");
    const after = (await mockApi.prStatus("a-billing")).pr!;
    expect(after.headSha).not.toBe(before.headSha);

    const stale = await mockApi.prMerge("a-billing", "squash", before.headSha!).catch((e: Error) => e.message);
    expect(isBranchChanged(String(stale))).toBe(true);
    expect((await mockApi.prStatus("a-billing")).pr!.state).toBe("open");

    const done = await mockApi.prMerge("a-billing", "squash", after.headSha!);
    expect(done).toMatch(/squashed/);
    expect((await mockApi.prStatus("a-billing")).pr!.state).toBe("merged");
  });
});
