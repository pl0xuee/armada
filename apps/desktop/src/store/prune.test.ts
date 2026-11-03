// Per-agent state in the small stores is dropped when an agent is deleted for real, but kept while the
// delete is still undoable (the agent is only hidden then) and for agents that merely leave the list.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedAgents } from "@/lib/mock-data";
import type { Agent, Checkpoint, PrStatus, TimelineItem } from "@/lib/types";

const prCalls: { id: string; resolve: (s: PrStatus) => void }[] = [];
const cpCalls: { id: string; resolve: (r: { available: boolean; checkpoints: Checkpoint[] }) => void }[] = [];
vi.mock("@/lib/api", () => ({
  api: {
    prStatus: (id: string) => new Promise<PrStatus>((resolve) => prCalls.push({ id, resolve })),
    listCheckpoints: (id: string) =>
      new Promise<{ available: boolean; checkpoints: Checkpoint[] }>((resolve) => cpCalls.push({ id, resolve })),
    probePorts: vi.fn(async () => []),
    workflowProgress: vi.fn(async () => ({ runId: "r", state: "running", agents: [] })),
    backgroundFinished: vi.fn(async () => {}),
  },
}));

const { markRemoved, useApp } = await import("./app");
const { usePinnedUi } = await import("./pinnedUi");
const { refreshPr, usePr } = await import("./pr");
const { ensureCheckpoints, useCheckpoints } = await import("./checkpoints");
const { useCompletion } = await import("./completion");
const { patchPreview, prunePreviews, usePreview } = await import("./preview");
const { usePermissionUi } = await import("./permissionUi");
const { useQuestionUi } = await import("./questionUi");
const { installBackgroundTracker, useBackgroundStore } = await import("./background");
const { resetWorkflows, useWorkflows, workflowKey } = await import("@/lib/workflows");

const agent = (id: string): Agent => ({ ...seedAgents()[0], id, status: "idle", archived: false });
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Ids nobody else uses: a deleted id stays deleted for the whole file. */
let n = 0;
const fresh = () => {
  const k = ++n;
  return { gone: `gone-${k}`, keep: `keep-${k}` };
};

beforeEach(() => {
  prCalls.length = 0;
  cpCalls.length = 0;
  useApp.setState({ agents: {}, items: {}, booted: false });
});

describe("agent deleted for real", () => {
  it("pinned plan state", () => {
    const { gone, keep } = fresh();
    for (const id of [gone, keep]) {
      usePinnedUi.getState().setPlanOpen(id, true);
      usePinnedUi.getState().setPlanPinned(id, true);
    }
    markRemoved(gone);
    const s = usePinnedUi.getState();
    expect(gone in s.planOpen || gone in s.planPinned).toBe(false);
    expect(s.planOpen[keep] && s.planPinned[keep]).toBe(true);
  });

  it("PR status, also one that was still on its way", async () => {
    const { gone, keep } = fresh();
    const ok = { state: "ok" } as unknown as PrStatus;
    const p1 = refreshPr(gone);
    const p2 = refreshPr(keep);
    prCalls[0].resolve(ok);
    prCalls[1].resolve(ok);
    await Promise.all([p1, p2]);
    expect(Object.keys(usePr.getState().byAgent)).toEqual(expect.arrayContaining([gone, keep]));

    const late = refreshPr(gone, true);
    markRemoved(gone);
    expect(gone in usePr.getState().byAgent).toBe(false);
    prCalls[2].resolve(ok);
    await late;
    expect(gone in usePr.getState().byAgent).toBe(false);
    expect(keep in usePr.getState().byAgent).toBe(true);
  });

  it("checkpoints, also a load that was still on its way", async () => {
    const { gone, keep } = fresh();
    ensureCheckpoints(gone);
    ensureCheckpoints(keep);
    cpCalls[0].resolve({ available: true, checkpoints: [] });
    cpCalls[1].resolve({ available: true, checkpoints: [] });
    await settle();
    expect(gone in useCheckpoints.getState().byAgent && keep in useCheckpoints.getState().byAgent).toBe(true);
    markRemoved(gone);
    expect(gone in useCheckpoints.getState().byAgent).toBe(false);
    expect(keep in useCheckpoints.getState().byAgent).toBe(true);

    const { gone: late } = fresh();
    ensureCheckpoints(late);
    markRemoved(late);
    cpCalls[2].resolve({ available: true, checkpoints: [] });
    await settle();
    expect(late in useCheckpoints.getState().byAgent).toBe(false);
  });

  it("the Done mark", () => {
    const { gone, keep } = fresh();
    useCompletion.setState({ done: { [gone]: true, [keep]: true } });
    markRemoved(gone);
    expect(useCompletion.getState().done).toEqual({ [keep]: true });
  });

  describe("preview state", () => {
    const store = new Map<string, string>();
    beforeEach(() => {
      store.clear();
      vi.stubGlobal("localStorage", {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      });
    });
    afterEach(() => vi.unstubAllGlobals());
    const saved = () => JSON.parse(store.get("armada.preview.v1") ?? "{}") as Record<string, unknown>;

    it("is dropped from memory and from storage, and a late scan can't bring it back", () => {
      const { gone, keep } = fresh();
      patchPreview(gone, { url: "http://localhost:3000" });
      patchPreview(keep, { url: "http://localhost:3001" });
      expect(Object.keys(saved())).toEqual(expect.arrayContaining([gone, keep]));
      markRemoved(gone);
      expect(gone in usePreview.getState().byAgent).toBe(false);
      expect(gone in saved()).toBe(false);
      expect(keep in saved()).toBe(true);
      patchPreview(gone, { live: ["http://localhost:3000"] });
      expect(gone in usePreview.getState().byAgent).toBe(false);
    });

    it("addresses of agents deleted in an earlier session go once the agent list is known", () => {
      const { gone, keep } = fresh();
      patchPreview(gone, { url: "http://localhost:4000" });
      patchPreview(keep, { url: "http://localhost:4001" });
      // Not booted yet: the list is empty, so nothing may be judged gone.
      expect(prunePreviews(() => true)).toBe(false);
      useApp.setState({ booted: true, agents: { [keep]: agent(keep) } });
      expect(gone in usePreview.getState().byAgent).toBe(false);
      expect(gone in saved()).toBe(false);
      expect(keep in saved()).toBe(true);
    });
  });

  it("approval and question cards kept for its requests", () => {
    const { gone, keep } = fresh();
    const item = (agentId: string, kind: "permission" | "question", requestId: string) =>
      ({ id: requestId, agentId, seq: 1, ts: 1, kind, requestId, resolution: null }) as unknown as TimelineItem;
    useApp.setState({
      items: {
        [gone]: [item(gone, "permission", `${gone}-p`), item(gone, "question", `${gone}-q`)],
        [keep]: [item(keep, "permission", `${keep}-p`), item(keep, "question", `${keep}-q`)],
      },
    });
    for (const id of [gone, keep]) {
      usePermissionUi.getState().setVisible(`${id}-p`, true);
      usePermissionUi.getState().setReasonDraft(`${id}-p`, "because");
      useQuestionUi.getState().setVisible(`${id}-q`, true);
    }
    markRemoved(gone);
    expect(usePermissionUi.getState().visible).toEqual({ [`${keep}-p`]: true });
    expect(usePermissionUi.getState().reasonDraft).toEqual({ [`${keep}-p`]: "because" });
    expect(useQuestionUi.getState().visible).toEqual({ [`${keep}-q`]: true });
  });

  describe("background work", () => {
    let off: (() => void) | null = null;
    beforeEach(() => {
      vi.stubGlobal("document", {
        documentElement: { dataset: {} },
        hidden: false,
        hasFocus: () => true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
      resetWorkflows();
    });
    afterEach(() => {
      off?.();
      off = null;
      resetWorkflows();
      useBackgroundStore.setState({ finishedAt: {} });
      vi.unstubAllGlobals();
    });

    it("workflow reports and the 'everything finished' note", () => {
      const { gone, keep } = fresh();
      const report = { progress: null, failed: false };
      useWorkflows.setState({
        byKey: {
          [workflowKey(gone, "t1")]: report,
          [workflowKey(gone, "t2")]: report,
          [workflowKey(keep, "t1")]: report,
        },
      });
      useBackgroundStore.setState({ finishedAt: { [gone]: 1, [keep]: 2 } });
      off = installBackgroundTracker();
      markRemoved(gone);
      expect(Object.keys(useWorkflows.getState().byKey)).toEqual([workflowKey(keep, "t1")]);
      expect(useBackgroundStore.getState().finishedAt).toEqual({ [keep]: 2 });
    });
  });
});

describe("agent that is only hidden (undoable delete) or archived", () => {
  it("keeps everything, so Undo and Unarchive find it as it was", () => {
    const { gone: id } = fresh();
    useApp.setState({ agents: { [id]: agent(id) } });
    usePinnedUi.getState().setPlanOpen(id, true);
    useCompletion.setState({ done: { [id]: true } });
    patchPreview(id, { url: "http://localhost:5000" });
    // Hidden by a pending delete: it leaves the list, nothing is told it was removed.
    useApp.setState({ agents: {} });
    expect(usePinnedUi.getState().planOpen[id]).toBe(true);
    expect(useCompletion.getState().done[id]).toBe(true);
    expect(usePreview.getState().byAgent[id]?.url).toBe("http://localhost:5000");
    // Archived: still an agent.
    useApp.setState({ agents: { [id]: { ...agent(id), archived: true } } });
    expect(usePinnedUi.getState().planOpen[id]).toBe(true);
  });
});
