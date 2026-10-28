import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: { workspaceTerminalOpen: vi.fn(async () => "t1"), terminalKill: vi.fn(async () => {}) },
}));

import { routeTerminalExit } from "@/lib/terminal-bus";
import { markRemoved, useApp } from "@/store/app";
import { agentWs, openTerminal, useWorkspace } from "./workspace";
import { seedAgents } from "@/lib/mock-data";

describe("workspace terminals", () => {
  it("applies an exit that was buffered before registration", async () => {
    const agent = seedAgents()[0];
    useApp.setState({ agents: { [agent.id]: agent } });
    routeTerminalExit("t1", 3);
    await openTerminal(agent.id);
    const t = agentWs(useWorkspace.getState(), agent.id).terms[0];
    expect(t.exit).toBe(3);
  });

  it("keeps terminals on a soft remove, disposes on real removal", () => {
    const agent = seedAgents()[0];
    expect(agentWs(useWorkspace.getState(), agent.id).terms.length).toBe(1);
    useApp.setState({ agents: {} });
    expect(agentWs(useWorkspace.getState(), agent.id).terms.length).toBe(1);
    markRemoved(agent.id);
    expect(agentWs(useWorkspace.getState(), agent.id).terms.length).toBe(0);
  });
});
