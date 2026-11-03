import { describe, expect, it, vi } from "vitest";

// The panel's Sync button: send the screen again even if unchanged, and do nothing without a live session.
const sent: (string | null)[] = [];
vi.mock("@/lib/api", () => ({
  api: {
    vaSetScreen: async (ctx: { agentId: string | null }) => {
      sent.push(ctx.agentId);
    },
  },
  onVaEvent: async () => () => {},
}));

describe("resyncScreen", () => {
  it("re-sends the same screen when live, and is a no-op otherwise", async () => {
    const { connectVoiceAssistant, resyncScreen, useVa } = await import("./voiceAssistant");
    const { useApp } = await import("./app");
    const { useUi } = await import("./ui");
    const { beginVa, initialVa } = await import("@/lib/voiceAssistant");
    const a1 = { id: "a1", archived: false, projectPath: "/p/one", status: "idle", lastActivityAt: 1 };
    useApp.setState({ settings: { voiceAssistant: { enabled: true } }, agents: { a1 } } as never);
    useUi.setState({ view: "agents", selectedAgentId: "a1" });
    vi.stubGlobal("document", { addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal("window", { getSelection: () => null });
    const off = connectVoiceAssistant();

    // Not live: nothing is sent.
    resyncScreen();
    expect(sent).toEqual([]);

    // Going live sends the screen once; Sync sends it again although nothing changed.
    useVa.setState({ ...beginVa(), visible: true });
    expect(sent).toEqual(["a1"]);
    resyncScreen();
    expect(sent).toEqual(["a1", "a1"]);

    // Session over: a no-op again.
    useVa.setState({ ...initialVa, visible: false });
    resyncScreen();
    expect(sent).toEqual(["a1", "a1"]);

    off();
    vi.unstubAllGlobals();
  });
});
