import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { beginVa, initialVa } from "@/lib/voiceAssistant";
import type { WakeStatus } from "@/lib/types";
import { useApp } from "./app";
import { startVoiceAssistant, useVa, wakeVoiceAssistant } from "./voiceAssistant";
import { refreshWakeStatus, useWake } from "./wake";

const setEnabled = (enabled: boolean) =>
  useApp.setState({ settings: { voiceAssistant: { enabled, wakeWord: true } } as never });

beforeEach(() => {
  useVa.setState({ ...initialVa, visible: false });
  useWake.setState({ status: null });
  setEnabled(true);
});
afterEach(() => vi.restoreAllMocks());

describe("hearing the wake phrase", () => {
  it("starts the assistant with what was said after it", async () => {
    vi.spyOn(api, "vaActive").mockResolvedValue(false);
    const start = vi.spyOn(api, "vaStart").mockResolvedValue();
    await wakeVoiceAssistant("what are my agents doing?");
    expect(start).toHaveBeenCalledWith("what are my agents doing?");
    expect(useVa.getState().visible).toBe(true);
  });

  it("starts with no request when nothing followed the phrase", async () => {
    vi.spyOn(api, "vaActive").mockResolvedValue(false);
    const start = vi.spyOn(api, "vaStart").mockResolvedValue();
    await wakeVoiceAssistant(null);
    expect(start).toHaveBeenCalledWith(null);
  });

  it("does nothing while the assistant is turned off", async () => {
    setEnabled(false);
    const active = vi.spyOn(api, "vaActive").mockResolvedValue(false);
    const start = vi.spyOn(api, "vaStart").mockResolvedValue();
    await wakeVoiceAssistant("hello");
    expect(start).not.toHaveBeenCalled();
    expect(active).not.toHaveBeenCalled();
  });

  it("leaves a live session alone", async () => {
    useVa.setState({ ...beginVa(), visible: true });
    const start = vi.spyOn(api, "vaStart").mockResolvedValue();
    await wakeVoiceAssistant("hello");
    expect(start).not.toHaveBeenCalled();
  });

  it("leaves a session the core still has alone (it wakes a paused one itself)", async () => {
    vi.spyOn(api, "vaActive").mockResolvedValue(true);
    const start = vi.spyOn(api, "vaStart").mockResolvedValue();
    await wakeVoiceAssistant("hello");
    expect(start).not.toHaveBeenCalled();
  });
});

describe("starting with a request", () => {
  it("passes it on to the core", async () => {
    vi.spyOn(api, "vaActive").mockResolvedValue(false);
    const start = vi.spyOn(api, "vaStart").mockResolvedValue();
    await startVoiceAssistant("open settings");
    expect(start).toHaveBeenCalledWith("open settings");
  });
});

describe("the shared wake status", () => {
  const listening: WakeStatus = { state: "listening", phrase: "Hey Kvistcode", model: "tiny.en", message: null };

  it("is filled from the core", async () => {
    vi.spyOn(api, "vaWakeStatus").mockResolvedValue(listening);
    await refreshWakeStatus();
    expect(useWake.getState().status).toEqual(listening);
  });

  it("keeps a newer event over a slower answer", async () => {
    const newer: WakeStatus = { ...listening, state: "waiting", message: "Paused while the assistant listens." };
    vi.spyOn(api, "vaWakeStatus").mockImplementation(async () => {
      useWake.setState({ status: newer });
      return listening;
    });
    await refreshWakeStatus();
    expect(useWake.getState().status).toEqual(newer);
  });

  it("stays as it was when the core can't answer", async () => {
    vi.spyOn(api, "vaWakeStatus").mockRejectedValue(new Error("gone"));
    await refreshWakeStatus();
    expect(useWake.getState().status).toBeNull();
  });
});
