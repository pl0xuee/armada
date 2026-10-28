// Small UI-level actions shared by several views (toasts + error handling).
import { toast } from "sonner";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { api } from "./api";
import { PROVIDERS } from "./providers";
import type { Account, Agent, PermissionOption, PermissionOptionKind, Provider, TimelineItem } from "./types";
import { errorMessage } from "./utils";

type PermissionItem = Extract<TimelineItem, { kind: "permission" }>;

export function findOption(item: PermissionItem, kinds: PermissionOptionKind[]): PermissionOption | undefined {
  for (const k of kinds) {
    const o = item.options.find((x) => x.kind === k);
    if (o) return o;
  }
  return undefined;
}

export async function respondPermission(agentId: string, item: PermissionItem, option: PermissionOption) {
  try {
    await api.respondPermission(agentId, item.requestId, option.id);
  } catch (e) {
    toast.error("Couldn't send your answer", { description: errorMessage(e) });
  }
}

/** Respond with the first option of the given family. Returns false if none matched. */
export async function quickRespond(
  agentId: string,
  item: PermissionItem,
  family: "allow_once" | "allow_always" | "reject",
): Promise<boolean> {
  const opt =
    family === "allow_once"
      ? findOption(item, ["allow_once", "allow_always"])
      : family === "allow_always"
        ? findOption(item, ["allow_always"])
        : findOption(item, ["reject_once", "reject_always"]);
  if (!opt) return false;
  await respondPermission(agentId, item, opt);
  return true;
}

export async function startLogin(account: Account) {
  try {
    const terminalId = await api.loginAccount(account.id);
    useUi.getState().setTerminal({
      terminalId,
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
    toast.error("Couldn't stop agent", { description: errorMessage(e) });
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
    toast.error(label, { description: errorMessage(e) });
    return null;
  }
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
    if (continueAfter) await api.sendPrompt(agent.id, CONTINUE_PROMPT);
    toast.success(`Now running on ${account.name}`, {
      id,
      description: continueAfter ? "Continuing where it left off." : "Send a message whenever you're ready.",
    });
    return true;
  } catch (e) {
    toast.error("Couldn't switch account", { id, description: errorMessage(e) });
    return false;
  }
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
