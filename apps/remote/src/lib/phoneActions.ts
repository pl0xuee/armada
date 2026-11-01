/**
 * Owner actions the phone gained after the controller was written: answering a spending-limit hold, the PR/CI
 * chip, conversation search and "How agents report". Same pattern as the controller's (busy flags, toasts on
 * failure, a 401 means the device was unpaired), kept in their own module.
 */
import type { HoldChoice } from "./budgetHold";
import { api } from "./api";
import { activeBackend, handleAuthError, toastError } from "./controller";
import { getState, setState } from "./store";
import type { Agent, ResponseStyle, SearchResults } from "./types";

/** The agent as it should look once the server has taken `choice` (its own update follows and wins). */
export function heldAfter(agent: Agent, choice: HoldChoice): Agent {
  if (choice.action === "stop") return { ...agent, budgetHold: null, queue: [], queuedPrompts: 0, queuePaused: false, acknowledgedAt: Date.now() };
  return { ...agent, budgetHold: null, queuePaused: false };
}

/** Raise the limit, continue for one turn, or stop. Returns whether the server took it. */
export async function resolveBudgetHold(agentId: string, choice: HoldChoice): Promise<boolean> {
  const b = activeBackend();
  const key = `budget:${agentId}`;
  if (!b || getState().busy[key]) return false;
  setState((s) => ({ busy: { ...s.busy, [key]: true } }));
  try {
    await api.budget(b, agentId, choice);
    setState((s) => (s.agents[agentId] ? { agents: { ...s.agents, [agentId]: heldAfter(s.agents[agentId], choice) } } : {}));
    return true;
  } catch (e) {
    if (!handleAuthError(e)) toastError(choice.action === "raise" ? "Couldn't raise the limit" : choice.action === "stop" ? "Couldn't stop the agent" : "Couldn't continue", e);
    return false;
  } finally {
    setState((s) => {
      const busy = { ...s.busy };
      delete busy[key];
      return { busy };
    });
  }
}

/** Agents whose PR status is being fetched, so a refresh doesn't start a second request. */
const prInFlight = new Set<string>();

/** Fetches the PR/CI status of an agent's branch into the store. Quiet: a failure keeps the last status. */
export async function loadPr(agentId: string): Promise<void> {
  const b = activeBackend();
  if (!b || prInFlight.has(agentId)) return;
  prInFlight.add(agentId);
  try {
    const snap = await api.pr(b, agentId);
    if (snap && typeof snap.state === "string") setState((s) => ({ prs: { ...s.prs, [agentId]: snap } }));
  } catch (e) {
    handleAuthError(e);
  } finally {
    prInFlight.delete(agentId);
  }
}

/** Searches every conversation. Throws on failure; the search box shows it. */
export async function searchConversations(query: string): Promise<SearchResults> {
  const b = activeBackend();
  if (!b) throw new Error("Not connected");
  try {
    return await api.search(b, query);
  } catch (e) {
    handleAuthError(e);
    throw e;
  }
}

/** "How agents report". Shown at once; put back if the server refuses. */
export async function setResponseStyle(style: ResponseStyle): Promise<void> {
  const b = activeBackend();
  const before = getState().responseStyle;
  if (!b || before === null || before === style) return;
  setState({ responseStyle: style });
  try {
    await api.setResponseStyle(b, style);
  } catch (e) {
    setState({ responseStyle: before });
    if (!handleAuthError(e)) toastError("Couldn't save the setting", e);
  }
}
