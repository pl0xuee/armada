import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "./api";
import { ApiError } from "./api";

const request = vi.fn();
const toastError = vi.fn();
const handleAuthError = vi.fn((e: unknown) => e instanceof ApiError && e.isUnauthorized);
vi.mock("./controller", () => ({
  activeBackend: () => ({ kind: "http", request }) as unknown as Backend,
  toastError: (...a: unknown[]) => toastError(...a),
  handleAuthError: (e: unknown) => handleAuthError(e),
}));

const { heldAfter, loadPr, resolveBudgetHold, searchConversations, setResponseStyle } = await import("./phoneActions");
const { getState, setState, initialState } = await import("./store");

import type { Agent } from "./types";

const held = { scope: "agent", metric: "cost", spent: 3.08, cap: 3, since: 1 } as Agent["budgetHold"];
const agent = (extra: Partial<Agent> = {}) =>
  ({ id: "h1", title: "Held", status: "idle", budgetHold: held, queue: [{ id: "q", text: "x", attachments: 0 }], queuedPrompts: 1, queuePaused: true, acknowledgedAt: null, ...extra }) as Agent;

beforeEach(() => {
  request.mockReset();
  toastError.mockReset();
  setState({ ...initialState, agents: { h1: agent() } });
});

describe("answering a hold", () => {
  it("posts the choice and lets the agent go on", async () => {
    request.mockResolvedValue(undefined);
    expect(await resolveBudgetHold("h1", { action: "raise", by: 5 })).toBe(true);
    expect(request).toHaveBeenCalledWith("POST", "/api/agents/h1/budget", { action: "raise", by: 5 });
    const a = getState().agents.h1;
    expect(a.budgetHold).toBeNull();
    expect(a.queuePaused).toBe(false);
    expect(a.queuedPrompts).toBe(1);
    expect(getState().busy).toEqual({});
  });

  it("'Continue once' keeps the queue; 'Stop' drops it and dismisses the item", async () => {
    request.mockResolvedValue(undefined);
    await resolveBudgetHold("h1", { action: "continue_once" });
    expect(request).toHaveBeenCalledWith("POST", "/api/agents/h1/budget", { action: "continue_once" });
    expect(getState().agents.h1.queue).toHaveLength(1);

    setState({ agents: { h1: agent() } });
    await resolveBudgetHold("h1", { action: "stop" });
    const a = getState().agents.h1;
    expect(a.budgetHold).toBeNull();
    expect(a.queue).toEqual([]);
    expect(a.queuedPrompts).toBe(0);
    expect(a.acknowledgedAt).toBeGreaterThan(0);
  });

  it("leaves the hold in place and says why when the server refuses", async () => {
    request.mockRejectedValue(new ApiError(400, "That is still under what was spent. Raise it by more."));
    expect(await resolveBudgetHold("h1", { action: "raise", by: 0.05 })).toBe(false);
    expect(getState().agents.h1.budgetHold).toEqual(held);
    expect(toastError).toHaveBeenCalledWith("Couldn't raise the limit", expect.any(ApiError));
    expect(getState().busy).toEqual({});
  });

  it("does not toast when the device was unpaired", async () => {
    request.mockRejectedValue(new ApiError(401, null));
    await resolveBudgetHold("h1", { action: "stop" });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("ignores a second tap while the first is on its way", async () => {
    let finish: () => void = () => {};
    request.mockReturnValue(new Promise<void>((r) => (finish = r)));
    const first = resolveBudgetHold("h1", { action: "raise", by: 5 });
    expect(await resolveBudgetHold("h1", { action: "raise", by: 5 })).toBe(false);
    finish();
    await first;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("describes the agent after each choice", () => {
    expect(heldAfter(agent(), { action: "raise", by: 1 }).budgetHold).toBeNull();
    expect(heldAfter(agent(), { action: "stop" }).queue).toEqual([]);
  });
});

describe("the PR chip's data", () => {
  it("stores what the server says, once per request in flight", async () => {
    const snap = { state: "ok", reason: null, pr: { number: 1 }, fetchedAt: 1 };
    let finish: (v: unknown) => void = () => {};
    request.mockReturnValue(new Promise((r) => (finish = r)));
    const a = loadPr("h1");
    const b = loadPr("h1");
    finish(snap);
    await Promise.all([a, b]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0].slice(0, 2)).toEqual(["GET", "/api/agents/h1/pr"]);
    expect(getState().prs.h1).toEqual(snap);
  });

  it("keeps the last status when asking fails, and ignores nonsense", async () => {
    const snap = { state: "ok", reason: null, pr: null, fetchedAt: 1 };
    setState({ prs: { h1: snap as never } });
    request.mockRejectedValue(new ApiError(0, null));
    await loadPr("h1");
    expect(getState().prs.h1).toEqual(snap);
    expect(toastError).not.toHaveBeenCalled();
    request.mockResolvedValue("<html>captive portal</html>");
    await loadPr("h1");
    expect(getState().prs.h1).toEqual(snap);
  });
});

describe("conversation search", () => {
  it("asks for the text, encoded", async () => {
    request.mockResolvedValue({ groups: [], indexing: false, truncated: false });
    await searchConversations("token & refresh?");
    expect(request).toHaveBeenCalledWith("GET", "/api/search?q=token%20%26%20refresh%3F");
  });
  it("passes a failure to the caller", async () => {
    request.mockRejectedValue(new ApiError(500, "boom"));
    await expect(searchConversations("ab")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("how agents report", () => {
  it("shows the choice at once and keeps it", async () => {
    setState({ responseStyle: "concise" });
    request.mockResolvedValue(undefined);
    const done = setResponseStyle("detailed");
    expect(getState().responseStyle).toBe("detailed");
    await done;
    expect(request).toHaveBeenCalledWith("POST", "/api/response-style", { style: "detailed" });
    expect(getState().responseStyle).toBe("detailed");
  });

  it("puts the old choice back when the server refuses", async () => {
    setState({ responseStyle: "concise" });
    request.mockRejectedValue(new ApiError(500, "no"));
    await setResponseStyle("balanced");
    expect(getState().responseStyle).toBe("concise");
    expect(toastError).toHaveBeenCalled();
  });

  it("does nothing for the style already chosen, or when the server doesn't offer it", async () => {
    setState({ responseStyle: "balanced" });
    await setResponseStyle("balanced");
    setState({ responseStyle: null });
    await setResponseStyle("detailed");
    expect(request).not.toHaveBeenCalled();
    expect(getState().responseStyle).toBeNull();
  });
});
