// Typed wrappers around the Rust commands in apps/desktop/src-tauri/src/commands.rs.
// Every backend call in the UI goes through here.
//
// Outside Tauri (plain `npm run dev` in a browser) every call is routed to an
// in-memory mock backend (./mock.ts) so the UI can be developed and reviewed
// without the Rust side. The mock is code-split and never loaded inside Tauri.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Account,
  Agent,
  AgentDiff,
  AppState,
  Attachment,
  ArmadaEvent,
  AttentionReason,
  CreateAccountRequest,
  CreateAgentRequest,
  CustomAgent,
  Provider,
  ProviderInfo,
  RemoteStatus,
  Schedule,
  SearchHit,
  Settings,
  ShareLink,
  TimelineItem,
  UpdateInfo,
} from "./types";

export const EVENT_CHANNEL = "armada://event";

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const tauriApi = {
  // state
  getState: () => invoke<AppState>("get_state"),
  listItems: (agentId: string) => invoke<TimelineItem[]>("list_items", { agentId }),
  search: (query: string) => invoke<SearchHit[]>("search", { query }),

  // agents
  createAgent: (req: CreateAgentRequest) => invoke<Agent>("create_agent", { req }),
  sendPrompt: (agentId: string, text: string, attachments?: Attachment[]) =>
    invoke<void>("send_prompt", { agentId, text, attachments: attachments ?? [] }),
  /** Fuzzy file search in the agent's cwd: top 50 relative paths. */
  listFiles: (agentId: string, query: string) => invoke<string[]>("list_files", { agentId, query }),
  cancelTurn: (agentId: string) => invoke<void>("cancel_turn", { agentId }),
  respondPermission: (agentId: string, requestId: string, optionId: string) =>
    invoke<void>("respond_permission", { agentId, requestId, optionId }),
  resumeAgent: (agentId: string, autoContinue: boolean) => invoke<void>("resume_agent", { agentId, autoContinue }),
  stopAgent: (agentId: string) => invoke<void>("stop_agent", { agentId }),
  deleteAgent: (agentId: string, removeWorktree: boolean) => invoke<void>("delete_agent", { agentId, removeWorktree }),
  renameAgent: (agentId: string, title: string) => invoke<void>("rename_agent", { agentId, title }),
  archiveAgent: (agentId: string, archived: boolean) => invoke<void>("archive_agent", { agentId, archived }),
  markRead: (agentId: string) => invoke<void>("mark_read", { agentId }),
  setAgentConfig: (agentId: string, optionId: string, value: string) =>
    invoke<void>("set_agent_config", { agentId, optionId, value }),
  /** Hand the agent's work to another provider/account with an instruction. */
  handoffAgent: (
    agentId: string,
    provider: Provider,
    accountId: string,
    instruction: string,
    customAgentId?: string | null,
  ) =>
    invoke<Agent>("handoff_agent", {
      agentId,
      provider,
      accountId,
      instruction,
      customAgentId: customAgentId ?? null,
    }),
  /** Move the agent (and its session) to another account of the same provider. */
  switchAccount: (agentId: string, accountId: string) => invoke<Agent>("switch_account", { agentId, accountId }),
  /** Shows a native save dialog (Markdown or JSON) and writes the transcript; returns the saved path, or null if cancelled. */
  exportAgent: (agentId: string) => invoke<string | null>("export_agent", { agentId }),
  /** Tell the backend what the user is looking at (for smart-mute). */
  setFocus: (agentId: string | null) => invoke<void>("set_focus", { agentId }),

  // review / git
  getDiff: (agentId: string) => invoke<AgentDiff>("get_diff", { agentId }),
  commitAgent: (agentId: string, message: string) => invoke<string>("commit_agent", { agentId, message }),
  mergeAgent: (agentId: string) => invoke<string>("merge_agent", { agentId }),
  createPr: (agentId: string, title: string, body: string) => invoke<string>("create_pr", { agentId, title, body }),
  discardWorktree: (agentId: string) => invoke<void>("discard_worktree", { agentId }),

  // accounts
  createAccount: (req: CreateAccountRequest) => invoke<Account>("create_account", { req }),
  updateAccount: (accountId: string, name: string, color: string) =>
    invoke<Account>("update_account", { accountId, name, color }),
  deleteAccount: (accountId: string) => invoke<void>("delete_account", { accountId }),
  checkAccount: (accountId: string) => invoke<Account>("check_account", { accountId }),
  /** Starts the provider's own login flow in a PTY; returns a terminal id. */
  loginAccount: (accountId: string) => invoke<string>("login_account", { accountId }),

  // providers
  detectProviders: () => invoke<ProviderInfo[]>("detect_providers"),
  /** Runs the install command in a PTY; returns a terminal id. */
  installProvider: (provider: Provider) => invoke<string>("install_provider", { provider }),
  /** Installs every missing CLI/adapter (private Node.js if needed); returns a terminal id. */
  installMissing: () => invoke<string>("install_missing"),

  // terminals (login / install)
  terminalWrite: (terminalId: string, data: string) => invoke<void>("terminal_write", { terminalId, data }),
  terminalResize: (terminalId: string, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { terminalId, cols, rows }),
  terminalKill: (terminalId: string) => invoke<void>("terminal_kill", { terminalId }),

  // settings & attention
  updateSettings: (settings: Settings) => invoke<Settings>("update_settings", { settings }),
  previewSound: (reason: AttentionReason) => invoke<void>("preview_sound", { reason }),
  testNotification: () => invoke<void>("test_notification"),
  openPath: (path: string) => invoke<void>("open_path", { path }),

  // schedules
  listSchedules: () => invoke<Schedule[]>("list_schedules"),
  /** Validates and saves; returns the saved schedule (with id). */
  saveSchedule: (schedule: Schedule) => invoke<Schedule>("save_schedule", { schedule }),
  deleteSchedule: (scheduleId: string) => invoke<void>("delete_schedule", { scheduleId }),
  runSchedule: (scheduleId: string) => invoke<Agent>("run_schedule", { scheduleId }),

  // custom agents
  /** Spawns the agent and runs the ACP handshake; resolves to e.g. "Gemini CLI 0.52.0 (ACP v1)". */
  testCustomAgent: (agent: CustomAgent) => invoke<string>("test_custom_agent", { agent }),

  // remote control / share links
  remoteStatus: () => invoke<RemoteStatus>("remote_status"),
  remoteRotateToken: () => invoke<RemoteStatus>("remote_rotate_token"),
  createShareLink: (agentId: string) => invoke<ShareLink>("create_share_link", { agentId }),
  revokeShareLink: (token: string) => invoke<void>("revoke_share_link", { token }),

  // updates
  checkForUpdate: () => invoke<UpdateInfo | null>("check_for_update"),
  /** Downloads, installs and restarts the app; progress via update_progress events. */
  installUpdate: () => invoke<void>("install_update"),
};

export type ArmadaApi = typeof tauriApi;

type AnyAsyncFn = (...args: unknown[]) => Promise<unknown>;

let mockModule: Promise<typeof import("./mock")> | null = null;
const loadMock = () => (mockModule ??= import("./mock"));

/** Same surface as `tauriApi`, each call forwarded to the lazily loaded mock backend. */
function createMockProxy(): ArmadaApi {
  const out: Record<string, AnyAsyncFn> = {};
  for (const key of Object.keys(tauriApi) as (keyof ArmadaApi)[]) {
    out[key] = (...args: unknown[]) => loadMock().then((m) => (m.mockApi[key] as unknown as AnyAsyncFn)(...args));
  }
  return out as unknown as ArmadaApi;
}

export const api: ArmadaApi = isTauri() ? tauriApi : createMockProxy();

export function onArmadaEvent(cb: (e: ArmadaEvent) => void): Promise<UnlistenFn> {
  if (!isTauri()) return loadMock().then((m) => m.subscribeMock(cb));
  return listen<ArmadaEvent>(EVENT_CHANNEL, (e) => cb(e.payload));
}
