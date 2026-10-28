import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { beginVa, initialVa, isLive, reduceVa } from "@/lib/voiceAssistant";
import { useApp } from "./app";
import {
  answerVaConfirm,
  escapeVoiceAssistant,
  startVoiceAssistant,
  toggleVoiceAssistant,
  useVa,
} from "./voiceAssistant";

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  useVa.setState({ ...initialVa, visible: false });
  useApp.setState({ settings: { voiceAssistant: { enabled: true } } as never });
});
afterEach(() => vi.restoreAllMocks());

describe("a transient error", () => {
  it("is a notice on a live session, so the panel stays up and isLive holds", () => {
    let s = reduceVa(beginVa(), { type: "state", state: "listening", message: null });
    s = reduceVa(s, { type: "notice", message: "server hiccup" });
    expect(s.phase).toBe("listening");
    expect(s.notice).toBe("server hiccup");
    expect(isLive(s)).toBe(true);
    s = reduceVa(s, { type: "notice", message: null });
    expect(s.notice).toBeNull();
  });

  it("is dropped once the session has ended", () => {
    let s = reduceVa(beginVa(), { type: "ended", reason: "ended", error: false });
    s = reduceVa(s, { type: "notice", message: "late" });
    expect(s.notice).toBeNull();
  });
});

describe("confirmations", () => {
  it("queue until answered and clear when the session ends", () => {
    let s = reduceVa(beginVa(), { type: "confirm_action", id: "c1", kind: "start_agent", summary: "Start" });
    s = reduceVa(s, { type: "confirm_action", id: "c1", kind: "start_agent", summary: "Start" });
    expect(s.confirms).toHaveLength(1);
    expect(reduceVa(s, { type: "confirm_done", id: "c1", status: "expired" }).confirms).toHaveLength(0);
    expect(reduceVa(s, { type: "ended", reason: "ended", error: false }).confirms).toHaveLength(0);
  });

  it("answering removes the card and tells the backend", () => {
    const confirm = vi.spyOn(api, "vaConfirm").mockResolvedValue();
    useVa.setState({ ...beginVa(), confirms: [{ id: "c1", kind: "start_agent", summary: "x" }] });
    answerVaConfirm("c1", true);
    expect(useVa.getState().confirms).toHaveLength(0);
    expect(confirm).toHaveBeenCalledWith("c1", true);
  });
});

describe("starting while the backend already has a session", () => {
  it("shows the panel instead of hiding it", async () => {
    vi.spyOn(api, "vaActive").mockResolvedValue(true);
    const start = vi.spyOn(api, "vaStart").mockResolvedValue();
    await startVoiceAssistant();
    expect(start).not.toHaveBeenCalled();
    expect(useVa.getState().visible).toBe(true);
    expect(isLive(useVa.getState())).toBe(true);
  });

  it("keeps the panel when va_start says 'already running' and the session is real", async () => {
    vi.spyOn(api, "vaActive").mockResolvedValueOnce(false).mockResolvedValue(true);
    vi.spyOn(api, "vaStart").mockRejectedValue(new Error("The voice assistant is already running."));
    await startVoiceAssistant();
    expect(useVa.getState().visible).toBe(true);
    expect(isLive(useVa.getState())).toBe(true);
  });

  it("hides the panel when starting really failed", async () => {
    vi.spyOn(api, "vaActive").mockResolvedValue(false);
    vi.spyOn(api, "vaStart").mockRejectedValue(new Error("no key"));
    await startVoiceAssistant();
    expect(useVa.getState().visible).toBe(false);
  });
});

describe("stopping", () => {
  it("the toggle stops a session the panel thinks is dead", async () => {
    // The panel shows an error, but the backend is still billing.
    useVa.setState({ ...initialVa, phase: "error", visible: true });
    vi.spyOn(api, "vaActive").mockResolvedValue(true);
    const stop = vi.spyOn(api, "vaStop").mockResolvedValue();
    const start = vi.spyOn(api, "vaStart").mockResolvedValue();
    toggleVoiceAssistant();
    await flush();
    expect(stop).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("Esc stops an active session, and only dismisses when none is", async () => {
    vi.spyOn(api, "vaActive").mockResolvedValue(true);
    const stop = vi.spyOn(api, "vaStop").mockResolvedValue();
    await escapeVoiceAssistant();
    expect(stop).toHaveBeenCalledTimes(1);
    vi.spyOn(api, "vaActive").mockResolvedValue(false);
    useVa.setState({ ...initialVa, phase: "error", visible: true });
    await escapeVoiceAssistant();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(useVa.getState().visible).toBe(false);
  });
});
