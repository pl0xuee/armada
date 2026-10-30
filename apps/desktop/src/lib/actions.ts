// Small UI-level actions shared by several views (toasts + error handling).
import { toast } from "sonner";
import { markRemoved, suppressAgent, useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { copyText } from "@/components/CopyButton";
import { api } from "./api";
import { PROVIDERS } from "./providers";
import type { Account, Agent, PermissionOption, PermissionOptionKind, Provider, TimelineItem } from "./types";
import { errorMessage } from "./utils";

type PermissionItem = Extract<TimelineItem, { kind: "permission" }>;

export function findOption(item: PermissionItem, kinds: PermissionOptionKind[]): PermissionOption | undefined {
  for (const k of kinds) {
    // A plan's "always" options switch the session's mode; no shortcut may pick one for you.
    if (k === "allow_always" && item.plan) continue;
    const o = item.options.find((x) => x.kind === k);
    if (o) return o;
  }
  return undefined;
}

/** Answer a permission request. Resolves false (after a toast) when the backend refused it. */
export async function respondPermission(
  agentId: string,
  item: PermissionItem,
  option: PermissionOption,
): Promise<boolean> {
  try {
    await api.respondPermission(agentId, item.requestId, option.id);
    return true;
  } catch (e) {
    toast.error("Couldn't send your answer", { description: errorMessage(e) });
    return false;
  }
}

/** Respond with the first option of the given family. Returns false if none matched or it failed. */
export async function quickRespond(
  agentId: string,
  item: PermissionItem,
  family: "allow_once" | "allow_always" | "reject",
): Promise<boolean> {
  const opt =
    family === "allow_once"
      ? findOption(item, ["allow_once"])
      : family === "allow_always"
        ? findOption(item, ["allow_always"])
        : findOption(item, ["reject_once", "reject_always"]);
  if (!opt) return false;
  return respondPermission(agentId, item, opt);
}

export async function startLogin(account: Account) {
  try {
    const { terminalId, reused, command } = await api.loginAccount(account.id);
    useUi.getState().setTerminal({
      terminalId,
      reused,
      command,
      kind: "login",
      accountId: account.id,
      title: `Sign in · ${account.name}`,
      subtitle: account.isSystem
        ? `Uses ${PROVIDERS[account.provider].name}'s default login`
        : `${PROVIDERS[account.provider].name} login runs in this account's isolated profile`,
    });
  } catch (e) {
    toast.error("Couldn't start sign-in", { description: errorMessage(e) });
  }
}

export async function startInstall(provider: Provider) {
  try {
    const terminalId = await api.installProvider(provider);
    useUi.getState().setTerminal({
      terminalId,
      kind: "install",
      provider,
      title: `Install ${PROVIDERS[provider].name}`,
      subtitle: useApp.getState().providers.find((p) => p.provider === provider)?.installCommand,
    });
  } catch (e) {
    toast.error("Couldn't start the installer", { description: errorMessage(e) });
  }
}

/** Update an agent tool to the newest release, or (rollback) back to the version Armada was tested with. */
export async function startToolUpdate(provider: Provider, rollback = false) {
  const name = PROVIDERS[provider].short;
  try {
    const terminalId = await api.updateTool(provider, rollback);
    useUi.getState().setTerminal({
      terminalId,
      kind: "install",
      provider,
      title: `${rollback ? "Roll back" : "Update"} ${name}`,
    });
  } catch (e) {
    toast.error(rollback ? "Couldn't start the roll back" : "Couldn't start the update", {
      description: errorMessage(e),
    });
  }
}

export async function checkAccount(account: Account) {
  try {
    const updated = await api.checkAccount(account.id);
    useApp.getState().upsertAccount(updated);
    if (updated.status?.loggedIn)
      toast.success(`${updated.name} is signed in`, { description: updated.status.label ?? undefined });
    else toast.warning(`${updated.name} is not signed in`, { description: updated.status?.error ?? undefined });
  } catch (e) {
    toast.error("Account check failed", { description: errorMessage(e) });
  }
}

export async function resumeAgent(agent: Agent) {
  try {
    await api.resumeAgent(agent.id, agent.status === "interrupted");
  } catch (e) {
    toast.error("Couldn't resume agent", { description: errorMessage(e) });
  }
}

export async function stopAgent(agent: Agent) {
  try {
    await api.stopAgent(agent.id);
  } catch (e) {
    toast.error("Couldn't shut down agent", { description: errorMessage(e) });
  }
}

export async function cancelTurn(agent: Agent) {
  try {
    await api.cancelTurn(agent.id);
  } catch (e) {
    toast.error("Couldn't cancel", { description: errorMessage(e) });
  }
}

/** Optimistic rename: the title updates immediately and reverts on failure. */
export async function renameAgent(agent: Agent, title: string) {
  const prev = useApp.getState().agents[agent.id];
  if (prev) useApp.getState().upsertAgent({ ...prev, title });
  try {
    await api.renameAgent(agent.id, title);
  } catch (e) {
    const cur = useApp.getState().agents[agent.id];
    if (cur) useApp.getState().upsertAgent({ ...cur, title: agent.title });
    toast.error("Couldn't rename agent", { description: errorMessage(e) });
  }
}

export async function archiveAgent(agent: Agent, archived: boolean) {
  const prev = useApp.getState().agents[agent.id];
  if (prev) useApp.getState().upsertAgent({ ...prev, archived });
  try {
    await api.archiveAgent(agent.id, archived);
    toast(archived ? `Archived “${agent.title}”` : `Restored “${agent.title}”`, {
      action: { label: "Undo", onClick: () => void archiveAgent({ ...agent, archived }, !archived) },
    });
  } catch (e) {
    const cur = useApp.getState().agents[agent.id];
    if (cur) useApp.getState().upsertAgent({ ...cur, archived: !archived });
    toast.error("Couldn't archive agent", { description: errorMessage(e) });
  }
}

/** Run an async op with a toast for failures; returns the result or null. */
export async function attempt<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    const msg = errorMessage(e);
    // Not a failure of the action: the core is quitting (e.g. the app is closing/updating).
    if (isShuttingDown(msg)) toast("Armada is shutting down", { id: "shutting-down" });
    else toast.error(label, { description: msg });
    return null;
  }
}

export function isShuttingDown(message: string): boolean {
  return message.includes("Armada is shutting down");
}

export async function installMissing() {
  try {
    const terminalId = await api.installMissing();
    useUi.getState().setTerminal({
      terminalId,
      kind: "install",
      title: "Install missing agents",
      subtitle: "No admin rights needed. If Node.js isn't installed, Armada downloads a private copy.",
    });
  } catch (e) {
    toast.error("Couldn't start the installer", { description: errorMessage(e) });
  }
}

/** Manual update check. Shows the banner when an update exists, a toast otherwise. */
export async function checkForUpdates(): Promise<void> {
  const id = toast.loading("Checking for updates…");
  try {
    const u = await api.checkForUpdate();
    if (u) {
      useApp.getState().setUpdate(u);
      toast.success(`Armada ${u.version} is available`, { id, description: "See the banner to install it." });
    } else {
      toast.success("You're up to date", { id, description: `Armada ${useApp.getState().version}` });
    }
  } catch (e) {
    toast.error("Couldn't check for updates", { id, description: errorMessage(e) });
  }
}

export async function installUpdate(): Promise<void> {
  const u = useApp.getState().update;
  if (!u) return;
  if (!u.canInstall) {
    await attempt("Couldn't open the download page", () => api.openPath(u.url));
    return;
  }
  useApp.setState({ updateProgress: { downloaded: 0, total: null } });
  try {
    await api.installUpdate();
  } catch (e) {
    useApp.setState({ updateProgress: null });
    toast.error("Update failed", { description: errorMessage(e) });
  }
}

export const CONTINUE_PROMPT = "Please continue where you left off.";

/** Move an agent to another account of the same provider; optionally nudge it to continue. */
export async function switchAccount(agent: Agent, account: Account, continueAfter: boolean): Promise<boolean> {
  const id = toast.loading(`Moving to ${account.name}…`);
  try {
    const updated = await api.switchAccount(agent.id, account.id);
    useApp.getState().upsertAgent(updated);
  } catch (e) {
    toast.error("Couldn't switch account", { id, description: errorMessage(e) });
    return false;
  }
  if (continueAfter) {
    try {
      await api.sendPrompt(agent.id, CONTINUE_PROMPT);
    } catch (e) {
      // The move itself worked; only the follow-up prompt failed.
      toast.warning(`Switched to ${account.name}, but couldn't continue`, {
        id,
        description: `${errorMessage(e)} Send a message to pick it up.`,
      });
      return true;
    }
  }
  toast.success(`Now running on ${account.name}`, {
    id,
    description: continueAfter ? "Continuing where it left off." : "Send a message whenever you're ready.",
  });
  return true;
}

/** Other signed-in accounts an agent could move to. */
export function switchCandidates(agent: Agent): Account[] {
  return useApp
    .getState()
    .accounts.filter((a) => a.provider === agent.provider && a.id !== agent.accountId && a.status?.loggedIn);
}

/** Export an agent's transcript (Markdown or JSON, chosen by extension). */
export async function exportConversation(agent: Agent) {
  try {
    const path = await api.exportAgent(agent.id);
    if (!path) return; // cancelled
    toast.success("Conversation exported", {
      description: path,
      // openPath reveals files in the file manager.
      action: {
        label: "Show in folder",
        onClick: () => void attempt("Couldn't show the file", () => api.openPath(path)),
      },
    });
  } catch (e) {
    toast.error("Export failed", { description: errorMessage(e) });
  }
}

/** Copies the diagnostics report to the clipboard for a bug report. */
export async function copyDiagnostics() {
  try {
    const report = await api.diagnostics();
    if (!(await copyText(report))) {
      toast.error("Couldn't copy to the clipboard", { description: "Try Save to file instead." });
      return;
    }
    toast.success("Diagnostics copied — paste it into your bug report");
  } catch (e) {
    toast.error("Couldn't collect diagnostics", { description: errorMessage(e) });
  }
}

/** Writes the diagnostics report to a file and offers to show it. */
export async function saveDiagnosticsFile() {
  try {
    const path = await api.saveDiagnostics();
    toast.success("Diagnostics saved", {
      description: path,
      action: {
        label: "Show in folder",
        onClick: () => void attempt("Couldn't show the file", () => api.openPath(path)),
      },
    });
  } catch (e) {
    toast.error("Couldn't save diagnostics", { description: errorMessage(e) });
  }
}

/** The real delete runs after DELETE_DELAY_MS; Undo is offered for less, so it can't race it. */
const DELETE_DELAY_MS = 6000;
const UNDO_MS = 5000;

/**
 * Delete with Undo: the agent disappears immediately and is deleted for real after a few
 * seconds unless the user undoes it. (Closing the app inside that window keeps the agent.)
 * Events for it are suppressed meanwhile, so Undo re-syncs from the core rather than trusting
 * the snapshot (the agent may have kept working, or asked for approval, in the meantime).
 */
export function deleteAgentWithUndo(agent: Agent, removeWorktree: boolean, force = false) {
  const app = useApp.getState();
  const snapshot = app.agents[agent.id];
  if (!snapshot) return;
  suppressAgent(agent.id, true);
  const agents = { ...app.agents };
  delete agents[agent.id];
  useApp.setState({ agents });
  const ui = useUi.getState();
  const wasSelected = ui.selectedAgentId === agent.id;
  if (wasSelected) useUi.setState({ selectedAgentId: null });

  // undo → restored; once the delete call starts, Undo is locked out.
  let state: "pending" | "undone" | "deleting" = "pending";

  const restore = async () => {
    suppressAgent(agent.id, false);
    useApp.setState((s) => ({ agents: { ...s.agents, [agent.id]: s.agents[agent.id] ?? snapshot } }));
    if (wasSelected && useUi.getState().selectedAgentId === null) useUi.getState().openAgent(agent.id);
    // Re-sync what happened while events were suppressed.
    try {
      const fresh = (await api.getState()).agents.find((a) => a.id === agent.id);
      if (fresh) useApp.setState((s) => ({ agents: { ...s.agents, [agent.id]: fresh } }));
    } catch {
      /* keep the snapshot; live events resume from here */
    }
    void useApp.getState().ensureItems(agent.id, true);
  };

  const timer = setTimeout(async () => {
    if (state !== "pending") return;
    state = "deleting";
    try {
      await api.deleteAgent(agent.id, removeWorktree, force);
      markRemoved(agent.id);
      suppressAgent(agent.id, false);
    } catch (e) {
      await restore();
      const msg = errorMessage(e);
      // The worktree holds work that exists nowhere else: nothing was deleted; let the user decide.
      if (msg.startsWith("Unsaved work: ")) {
        toast.warning(`“${agent.title}” wasn't deleted`, {
          description: msg.slice("Unsaved work: ".length),
          duration: 15_000,
          action: {
            label: "Delete anyway",
            onClick: () => {
              const cur = useApp.getState().agents[agent.id];
              if (cur) deleteAgentWithUndo(cur, removeWorktree, true);
            },
          },
          cancel: { label: "Review diff", onClick: () => useUi.getState().setReviewAgent(agent.id) },
        });
      } else {
        toast.error("Couldn't delete agent", { description: msg });
      }
    }
  }, DELETE_DELAY_MS);

  toast(`Deleted “${agent.title}”`, {
    description: removeWorktree
      ? force
        ? "Its worktree and unsaved work will be discarded."
        : "Its worktree will be removed too."
      : undefined,
    duration: UNDO_MS,
    action: {
      label: "Undo",
      onClick: () => {
        if (state !== "pending") {
          toast("Too late to undo", { description: "The agent was already deleted." });
          return;
        }
        state = "undone";
        clearTimeout(timer);
        void restore();
      },
    },
  });
}
