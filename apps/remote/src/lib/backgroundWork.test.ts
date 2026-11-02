import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "./api";
import { ApiError } from "./api";

const request = vi.fn();
const pushToast = vi.fn();
const backend = { kind: "http", request } as unknown as Backend;
let route: { name: string; agentId?: string } = { name: "fleet" };
vi.mock("./controller", () => ({
  activeBackend: () => backend,
  handleAuthError: (e: unknown) => e instanceof ApiError && e.isUnauthorized,
  pushToast: (...a: unknown[]) => pushToast(...a),
}));
vi.mock("./router", () => ({ getRoute: () => route }));

const { BACKGROUND_POLL_MS, finishedAgents, installBackgroundTracker } = await import("./backgroundWork");
const { getState, setState, initialState } = await import("./store");
import type { Agent } from "./types";

const agent = (id: string, extra: Partial<Agent> = {}) =>
  ({ id, title: `Agent ${id}`, status: "idle", archived: false, unread: true, ...extra }) as Agent;
const running = { a1: { workflows: 1, working: 3, total: 5 } };
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

let off: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  request.mockReset();
  pushToast.mockReset();
  route = { name: "fleet" };
  Object.defineProperty(globalThis, "document", { value: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} }, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
  setState({ ...initialState, phase: "ready" });
  off = installBackgroundTracker();
});
afterEach(() => {
  off();
  vi.useRealTimers();
});

const load = (agents: Record<string, Agent>) => setState({ agents, stateStatus: "ready" });

describe("the background tracker", () => {
  it("asks once when idle agents first load, and does not poll while nothing runs", async () => {
    request.mockResolvedValue({ agents: {} });
    load({ a1: agent("a1") });
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("GET", "/api/background");
    await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_MS * 4);
    expect(request).toHaveBeenCalledTimes(1);
    // A snapshot refresh that changes nothing about who is idle asks nothing either.
    load({ a1: agent("a1", { lastMessage: "hi" }) });
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps asking while a workflow runs, and says so once it ends", async () => {
    request.mockResolvedValue({ agents: running });
    load({ a1: agent("a1") });
    await flush();
    expect(getState().background).toEqual({ a1: { workflows: 1, working: 3, total: 5, subagents: 0 } });
    await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_MS);
    expect(request).toHaveBeenCalledTimes(2);

    request.mockResolvedValue({ agents: {} });
    await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_MS);
    expect(getState().background).toEqual({});
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(pushToast.mock.calls[0][0]).toMatchObject({ title: "Agent a1", body: "Everything finished", agentId: "a1" });
    // Nothing left running: the polling stops.
    const calls = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_MS * 3);
    expect(request.mock.calls.length).toBe(calls);
  });

  it("does not toast about the agent that is open in front of the reader", async () => {
    request.mockResolvedValue({ agents: running });
    load({ a1: agent("a1") });
    await flush();
    route = { name: "agent", agentId: "a1" };
    request.mockResolvedValue({ agents: {} });
    await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_MS);
    expect(getState().background).toEqual({});
    expect(pushToast).not.toHaveBeenCalled();
  });

  it("an agent that starts a new turn drops out at once, quietly", async () => {
    request.mockResolvedValue({ agents: running });
    load({ a1: agent("a1") });
    await flush();
    load({ a1: agent("a1", { status: "working" }) });
    expect(getState().background).toEqual({});
    request.mockResolvedValue({ agents: {} });
    await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_MS * 2);
    expect(pushToast).not.toHaveBeenCalled();
  });

  it("asks again when a turn ends (the agent turns idle)", async () => {
    request.mockResolvedValue({ agents: {} });
    load({ a1: agent("a1", { status: "working" }) });
    await flush();
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValue({ agents: running });
    load({ a1: agent("a1") });
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(Object.keys(getState().background)).toEqual(["a1"]);
  });

  it("an older server (404) is asked no more; a failed read keeps what was known", async () => {
    request.mockRejectedValue(new ApiError(404, null));
    load({ a1: agent("a1") });
    await flush();
    load({ a1: agent("a1"), a2: agent("a2") });
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(getState().background).toEqual({});
  });

  it("keeps the last answer when a read fails", async () => {
    request.mockResolvedValueOnce({ agents: running });
    load({ a1: agent("a1") });
    await flush();
    request.mockRejectedValue(new ApiError(0, null));
    await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_MS);
    expect(Object.keys(getState().background)).toEqual(["a1"]);
    expect(pushToast).not.toHaveBeenCalled();
  });
});

describe("finishedAgents", () => {
  it("names agents whose workflow ended while they sat idle", () => {
    const b = { a1: { workflows: 1, working: 1, total: 2, subagents: 0 }, a2: { workflows: 1, working: 1, total: 2, subagents: 0 } };
    const agents = { a1: agent("a1"), a2: agent("a2", { status: "working" }) };
    expect(finishedAgents(b, {}, agents)).toEqual(["a1"]);
    expect(finishedAgents(b, { a1: b.a1 }, agents)).toEqual([]);
  });
});
