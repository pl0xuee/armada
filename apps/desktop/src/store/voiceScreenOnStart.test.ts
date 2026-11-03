import { describe, expect, it, vi } from "vitest";

// The backend forgets the screen when a session starts, so the app must send it again afterwards.
const calls: string[] = [];
let backendKnows: string | null = null;
vi.mock("@/lib/api", () => ({
  api: {
    vaActive: async () => false,
    vaStart: async () => {
      calls.push("start");
      backendKnows = null; // a new session clears the screen
    },
    vaSetScreen: async (ctx: { agentId: string | null }) => {
      calls.push(`screen:${ctx.agentId}`);
      backendKnows = ctx.agentId;
    },
  },
  onVaEvent: async () => () => {},
}));

describe("assistant sees the open agent when it starts", () => {
  it("sends the screen again once the session exists", async () => {
    const { connectVoiceAssistant, startVoiceAssistant } = await import("./voiceAssistant");
    const { useApp } = await import("./app");
    const { useUi } = await import("./ui");
    useApp.setState({ settings: { voiceAssistant: { enabled: true } } as never });
    useUi.setState({ view: "agents", selectedAgentId: "a1" });
    vi.stubGlobal("document", { addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal("window", { getSelection: () => null });
    const off = connectVoiceAssistant();
    await startVoiceAssistant();
    expect(calls[calls.length - 1]).toBe("screen:a1");
    expect(backendKnows).toBe("a1");
    off();
    vi.unstubAllGlobals();
  });
});
