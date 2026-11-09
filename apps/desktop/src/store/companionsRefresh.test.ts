import { beforeEach, describe, expect, it, vi } from "vitest";

const listCompanions = vi.fn();
vi.mock("@/lib/api", () => ({ api: { listCompanions: () => listCompanions() } }));

const { useCompanions } = await import("./companions");

describe("companion refresh", () => {
  beforeEach(() => listCompanions.mockReset());

  it("shares a check already running", async () => {
    let finish!: (v: unknown[]) => void;
    listCompanions.mockReturnValueOnce(new Promise((r) => (finish = r)));
    const a = useCompanions.getState().refresh();
    const b = useCompanions.getState().refresh();
    finish([]);
    await Promise.all([a, b]);
    expect(listCompanions).toHaveBeenCalledTimes(1);
  });

  it("looks again after an install even while an older check runs", async () => {
    let finish!: (v: unknown[]) => void;
    listCompanions.mockReturnValueOnce(new Promise((r) => (finish = r)));
    listCompanions.mockResolvedValueOnce([{ id: "git", installed: true }]);
    const old = useCompanions.getState().refresh();
    const fresh = useCompanions.getState().refresh(true);
    finish([{ id: "git", installed: false }]);
    await old;
    expect(await fresh).toEqual([{ id: "git", installed: true }]);
    expect(useCompanions.getState().list).toEqual([{ id: "git", installed: true }]);
  });
});
